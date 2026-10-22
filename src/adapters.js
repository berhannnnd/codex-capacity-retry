/**
 * Runtime boundary for a verified Codex/Desktop integration.
 * The UI can be wired to this interface without assuming that control exists.
 */
export class TaskAdapter {
  async getTask(_taskId) { throw new Error('TaskAdapter.getTask is not implemented'); }
  async retry(_taskId) { throw new Error('TaskAdapter.retry is not implemented'); }
  async continueInNewSession(_taskId) { throw new Error('TaskAdapter.continueInNewSession is not implemented'); }
  async switchModel(_taskId, _model) { throw new Error('TaskAdapter.switchModel is not implemented'); }
}

export class SimulatedTaskAdapter extends TaskAdapter {
  constructor() { super(); this.events = []; }
  async getTask(taskId) { return { id: taskId, state: 'paused', adapter: 'simulation' }; }
  async retry(taskId) { this.events.push({ type: 'retry', taskId, at: Date.now() }); return { ok: true, mode: 'simulation' }; }
  async continueInNewSession(taskId) { this.events.push({ type: 'continue', taskId, at: Date.now() }); return { ok: true, sessionId: `${taskId}-new`, mode: 'simulation' }; }
  async switchModel(taskId, model) { this.events.push({ type: 'switch-model', taskId, model, at: Date.now() }); return { ok: true, model, mode: 'simulation' }; }
}
