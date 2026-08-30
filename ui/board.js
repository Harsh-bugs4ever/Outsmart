/**
 * Queue board: one row per run, derived from the harness's session events.
 *
 * The harness has no "status" field on a session - state is whatever the event
 * stream says. Deriving it here keeps the board honest: it reports what the
 * run actually did, not what anything claimed about it.
 */

const POLL_MS = 3000;
const rowsEl = document.getElementById('rows');
const statusEl = document.getElementById('status');

/** Gated tool calls per session, so the buttons can resume the turn. */
const pending = new Map();
/** Sessions with a decision in flight, to keep decisions single-flight. */
const inFlight = new Set();
/** Guards against overlapping refreshes finishing out of order. */
let refreshing = false;

async function api(path, options) {
  const response = await fetch(`/api/v1${path}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  return body;
}

/**
 * Reduce a session's events to a single state.
 *
 * The API returns events newest-first, so they are sorted chronologically
 * before reducing - reducing in array order ends on the oldest `turn.created`
 * and reports a finished run as still running.
 *
 * There is no `user.tool_approval` event in the stream: an approval's
 * resolution shows up as the turn simply completing. So an approval counts as
 * outstanding only while nothing later has closed or restarted the turn.
 */
function deriveState(rawEvents) {
  const events = rawEvents
    .map((entry) => entry.event ?? entry)
    .filter((event) => event?.created_at)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  // Tool names live on the model message that requested the call, which an
  // approval references by `source_event_id`.
  const byId = new Map(events.map((event) => [event.id, event]));
  const nameFor = (call) => {
    const source = byId.get(call.source_event_id);
    const match = (source?.tool_calls ?? []).find((c) => c.id === call.id);
    return match?.function?.name ?? match?.name ?? null;
  };

  let state = 'queued';
  let steps = 0;
  let failed = false;
  const gated = [];

  for (const event of events) {
    switch (event.type) {
      case 'turn.created':
        // A new turn supersedes whatever the previous one did, including a
        // failure - otherwise one bad turn marks the session failed forever,
        // even after a successful retry.
        state = 'running';
        failed = false;
        gated.length = 0;
        break;
      case 'tool.response':
        steps += 1;
        break;
      case 'tool.approval_required':
        // A turn can emit several approval-required events. Accumulate them:
        // overwriting would leave the earlier gated calls unresolved, and the
        // run could never resume.
        for (const call of event.tool_calls ?? []) {
          if (gated.some((g) => g.id === call.id)) continue;
          gated.push({ id: call.id, threadId: event.thread_id, name: nameFor(call) });
        }
        break;
      case 'turn.done':
        state = 'done';
        failed = false;
        gated.length = 0;
        break;
      case 'turn.failed':
      case 'error':
        failed = true;
        gated.length = 0;
        break;
      default:
        break;
    }

    // "fixing" is not a harness concept - it is the repair loop. Every run
    // executes `npm test` for its green baseline, so matching the command
    // labels healthy runs as repair work from the baseline onward. Match
    // evidence of a *failure* instead - and a non-zero count, since some
    // reporters print "0 failing" on a healthy run.
    if (state === 'running' && /[1-9]\d*\s+failing|tests? failed|npm ERR!|AssertionError/i.test(JSON.stringify(event))) {
      state = 'fixing';
    }
  }

  if (gated.length) return { state: 'waiting', steps, gated };
  if (failed) return { state: 'failed', steps, gated: [] };
  return { state, steps, gated: [] };
}

const LABELS = {
  queued: 'queued',
  running: 'running',
  fixing: 'fixing',
  waiting: 'awaiting approval',
  done: 'done',
  failed: 'failed',
  unknown: 'state unavailable',
};

function relative(iso) {
  if (!iso) return '—';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

async function decide(sessionId, status, buttons) {
  // Claim the decision synchronously, before any await. Two rapid clicks -
  // or approve then reject - would otherwise both pass the guard and submit
  // contradictory decisions for the same tool calls.
  const waiting = pending.get(sessionId);
  if (!waiting || inFlight.has(sessionId)) return;
  inFlight.add(sessionId);
  pending.delete(sessionId);
  for (const button of buttons) button.disabled = true;

  const input = waiting.map((call) => ({
    type: 'user.tool_approval',
    thread_id: call.threadId,
    tool_call_id: call.id,
    approval: status === 'allow'
      ? { status: 'allow' }
      : { status: 'deny', reason: 'Rejected from the Outsmart queue board.' },
  }));

  try {
    await api(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input, stream: false }),
    });
  } catch (error) {
    // Restore the gate: a failed submission must not look like a decision.
    pending.set(sessionId, waiting);
    for (const button of buttons) button.disabled = false;
    statusEl.className = 'status error';
    statusEl.textContent = `approval failed: ${error.message}`;
    return;
  } finally {
    inFlight.delete(sessionId);
  }

  await refresh();
}

function renderRow(session, { state, steps, gated }) {
  const row = document.createElement('tr');

  const title = document.createElement('td');
  title.innerHTML = `<span class="run-title"></span><span class="run-id"></span>`;
  title.querySelector('.run-title').textContent = session.title ?? '(untitled run)';
  title.querySelector('.run-id').textContent = session.id;

  const stateCell = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = `badge ${state}` + (['running', 'fixing', 'waiting'].includes(state) ? ' pulse' : '');
  badge.textContent = LABELS[state] ?? state;
  stateCell.append(badge);

  const activity = document.createElement('td');
  activity.className = 'muted';
  activity.textContent = relative(session.updated_at);

  const stepCell = document.createElement('td');
  stepCell.className = 'muted';
  stepCell.textContent = steps ? `${steps} tool calls` : '—';

  const actions = document.createElement('td');
  if (gated.length) {
    const names = gated.map((g) => g.name).filter(Boolean);
    const label = document.createElement('span');
    label.className = 'pending-tool';
    label.textContent = names.length ? names.join(', ') : `${gated.length} tool call(s)`;

    const approve = document.createElement('button');
    approve.className = 'approve';
    approve.textContent = 'Approve';
    const reject = document.createElement('button');
    reject.className = 'reject';
    reject.textContent = 'Reject';
    const buttons = [approve, reject];
    approve.onclick = () => decide(session.id, 'allow', buttons);
    reject.onclick = () => decide(session.id, 'deny', buttons);

    actions.append(label, approve, document.createTextNode(' '), reject);
  } else {
    actions.className = 'muted';
    actions.textContent = state === 'done' ? 'not required' : '—';
  }

  row.append(title, stateCell, activity, stepCell, actions);
  return row;
}

async function refresh() {
  // Skip if a refresh is still running. Overlapping refreshes can finish out
  // of order, and a slow one landing last would re-expose a gate that a newer
  // pass already saw resolved.
  if (refreshing) return;
  refreshing = true;

  try {
    const { data: sessions } = await api('/sessions');
    const rows = [];
    let unreadable = 0;

    for (const session of sessions) {
      let derived;
      try {
        const { data: events } = await api(`/sessions/${session.id}/events`);
        derived = deriveState(events);
      } catch {
        // Never fall back to "queued" - an unreadable run is not an idle one,
        // and an operator must be able to tell the difference.
        derived = { state: 'unknown', steps: 0, gated: [] };
        unreadable += 1;
      }

      // A decision in flight owns this session's gate until it resolves.
      if (!inFlight.has(session.id)) {
        if (derived.gated.length) pending.set(session.id, derived.gated);
        else pending.delete(session.id);
      }
      rows.push(renderRow(session, derived));
    }

    rowsEl.replaceChildren(...(rows.length ? rows : [emptyRow()]));
    statusEl.className = unreadable ? 'status error' : 'status';
    statusEl.textContent = unreadable
      ? `${sessions.length} runs · ${unreadable} unreadable · updated ${new Date().toLocaleTimeString()}`
      : `${sessions.length} runs · updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    statusEl.className = 'status error';
    statusEl.textContent = error.message;
  } finally {
    refreshing = false;
  }
}

function emptyRow() {
  const row = document.createElement('tr');
  row.className = 'empty';
  const cell = document.createElement('td');
  cell.colSpan = 5;
  cell.textContent = 'No runs yet.';
  row.append(cell);
  return row;
}

refresh();
setInterval(refresh, POLL_MS);
