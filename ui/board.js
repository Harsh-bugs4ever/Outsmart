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

/** Pending approvals, keyed by session id, so the buttons can resume a turn. */
const pending = new Map();

async function api(path, options) {
  const response = await fetch(`/api/v1${path}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  return body;
}

/**
 * Reduce a session's events to a single state.
 *
 * Order matters: an approval that is still outstanding outranks "running",
 * because a run waiting on a human is the thing an operator needs to see.
 */
function deriveState(events) {
  let state = 'queued';
  let steps = 0;
  let awaiting = null;
  let failed = false;

  for (const { event } of events) {
    switch (event.type) {
      case 'turn.created':
        state = 'running';
        break;
      case 'tool.response':
        steps += 1;
        break;
      case 'tool.approval_required':
        awaiting = { threadId: event.thread_id, toolCalls: event.tool_calls ?? [] };
        break;
      case 'user.tool_approval':
        awaiting = null;
        break;
      case 'turn.done':
        state = 'done';
        break;
      case 'turn.failed':
      case 'error':
        failed = true;
        break;
      default:
        break;
    }

    // "fixing" is not a harness concept - it is the repair loop, which shows up
    // as the agent running tests or editing files after a failure.
    const text = JSON.stringify(event);
    if (state === 'running' && /npm test|mocha|failing|repair/i.test(text)) state = 'fixing';
  }

  if (failed) return { state: 'failed', steps, awaiting: null };
  if (awaiting) return { state: 'waiting', steps, awaiting };
  return { state, steps, awaiting: null };
}

const LABELS = {
  queued: 'queued',
  running: 'running',
  fixing: 'fixing',
  waiting: 'awaiting approval',
  done: 'done',
  failed: 'failed',
};

function relative(iso) {
  if (!iso) return '—';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

async function decide(sessionId, status) {
  const waiting = pending.get(sessionId);
  if (!waiting) return;

  const input = waiting.toolCalls.map((call) => ({
    type: 'user.tool_approval',
    thread_id: waiting.threadId,
    tool_call_id: call.id ?? call.tool_call_id,
    approval: status === 'allow'
      ? { status: 'allow' }
      : { status: 'deny', reason: 'Rejected from the Outsmart queue board.' },
  }));

  await api(`/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, stream: false }),
  });

  pending.delete(sessionId);
  await refresh();
}

function renderRow(session, { state, steps, awaiting }) {
  const row = document.createElement('tr');

  const title = document.createElement('td');
  title.innerHTML = `<span class="run-title"></span><span class="run-id"></span>`;
  title.querySelector('.run-title').textContent = session.title ?? '(untitled run)';
  title.querySelector('.run-id').textContent = session.id;

  const stateCell = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = `badge ${state}` + (['running', 'fixing', 'waiting'].includes(state) ? ' pulse' : '');
  badge.textContent = LABELS[state];
  stateCell.append(badge);

  const activity = document.createElement('td');
  activity.className = 'muted';
  activity.textContent = relative(session.updated_at);

  const stepCell = document.createElement('td');
  stepCell.className = 'muted';
  stepCell.textContent = steps ? `${steps} tool calls` : '—';

  const actions = document.createElement('td');
  if (awaiting) {
    const names = awaiting.toolCalls.map((c) => c.function?.name ?? c.name).filter(Boolean);
    const label = document.createElement('span');
    label.className = 'pending-tool';
    label.textContent = names.length ? names.join(', ') : 'tool call';
    const approve = document.createElement('button');
    approve.className = 'approve';
    approve.textContent = 'Approve';
    approve.onclick = () => decide(session.id, 'allow');
    const reject = document.createElement('button');
    reject.className = 'reject';
    reject.textContent = 'Reject';
    reject.onclick = () => decide(session.id, 'deny');
    actions.append(label, approve, document.createTextNode(' '), reject);
  } else {
    actions.className = 'muted';
    actions.textContent = state === 'done' ? 'not required' : '—';
  }

  row.append(title, stateCell, activity, stepCell, actions);
  return row;
}

async function refresh() {
  try {
    const { data: sessions } = await api('/sessions');
    const rows = [];

    for (const session of sessions) {
      let derived = { state: 'queued', steps: 0, awaiting: null };
      try {
        const { data: events } = await api(`/sessions/${session.id}/events`);
        derived = deriveState(events);
      } catch {
        // A session whose events cannot be read is still worth showing.
      }
      if (derived.awaiting) pending.set(session.id, derived.awaiting);
      else pending.delete(session.id);
      rows.push(renderRow(session, derived));
    }

    rowsEl.replaceChildren(...(rows.length ? rows : [emptyRow()]));
    statusEl.className = 'status';
    statusEl.textContent = `${sessions.length} runs · updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    statusEl.className = 'status error';
    statusEl.textContent = error.message;
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
