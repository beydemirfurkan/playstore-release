// The edit transaction. On this API nothing — not even a read of the listing —
// happens outside an edit: insert one, change things inside it, validate, commit.
// An edit that is never committed changes nothing and expires on its own; one
// left open blocks the next insert for a while, which is why every path through
// the CLI ends in commit or discard.
//
// The manager is lazy: the first read or write inserts the edit. `hold()` is
// what lets a pipeline run six operations inside one edit and commit once.

export class EditManager {
  /**
   * @param {{ client: import("./client.mjs").PlayClient, log?: import("../core/events.mjs").Log | null }} deps
   */
  constructor({ client, log = null }) {
    this.client = client;
    this.log = log;
    /** @type {string|null} */
    this.id = null;
    this.expiry = null;
    /** How many mutations were sent into the open edit. */
    this.dirty = 0;
    /** True while a pipeline owns the commit. */
    this.held = false;
    /** Facts operations leave for each other (e.g. the versionCode just uploaded). */
    this.notes = {};
  }

  /** Insert an edit if none is open. Real even under dry run — reads need it. */
  async ensure() {
    if (this.id) return this.id;
    const res = await this.client.post("/edits", {}, { lifecycle: true });
    this.id = res.id;
    this.expiry = res.expiryTimeSeconds ?? null;
    this.dirty = 0;
    return this.id;
  }

  /** @private */
  async _path(sub) {
    const id = await this.ensure();
    return `/edits/${id}${sub}`;
  }

  async get(sub, opts) {
    return this.client.get(await this._path(sub), opts);
  }
  async put(sub, body, opts) {
    this.dirty += 1;
    return this.client.put(await this._path(sub), body, opts);
  }
  async patch(sub, body, opts) {
    this.dirty += 1;
    return this.client.patch(await this._path(sub), body, opts);
  }
  async post(sub, body, opts) {
    this.dirty += 1;
    return this.client.post(await this._path(sub), body, opts);
  }
  async delete(sub, opts) {
    this.dirty += 1;
    return this.client.delete(await this._path(sub), opts);
  }
  async upload(sub, media) {
    this.dirty += 1;
    return this.client.upload(await this._path(sub), media);
  }

  /** Something an operation wants a later one to know within the same edit. */
  note(key, value) {
    this.notes[key] = value;
  }

  hold() {
    this.held = true;
  }
  unhold() {
    this.held = false;
  }

  /** Ask Google whether the edit would commit. Throws a PlayApiError naming what is wrong. */
  async validate() {
    if (!this.id) return null;
    return this.client.post(`/edits/${this.id}:validate`, undefined, { lifecycle: true });
  }

  /**
   * Validate and commit the open edit — or discard it when there is nothing to
   * commit, or when this is a dry run (commit is the one call never made then).
   *
   * @param {{ changesNotSentForReview?: boolean }} [opts]
   * @returns {Promise<{ outcome: "none"|"discarded"|"planned"|"committed", id?: string }>}
   */
  async commit({ changesNotSentForReview = false } = {}) {
    if (!this.id) return { outcome: "none" };
    const id = this.id;
    if (!this.dirty || this.client.dryRun) {
      const outcome = this.client.dryRun && this.dirty ? "planned" : "discarded";
      await this.discard();
      return { outcome, id };
    }
    await this.validate();
    const query = changesNotSentForReview ? "?changesNotSentForReview=true" : "";
    const res = await this.client.post(`/edits/${id}:commit${query}`, undefined);
    this.log?.change({ resource: "edit", id, action: "commit", applied: true });
    this.id = null;
    this.dirty = 0;
    this.notes = {};
    return { outcome: "committed", id: res.id ?? id };
  }

  /** Delete the open edit, forgiving a 404 (already expired or committed). */
  async discard() {
    if (!this.id) return;
    const id = this.id;
    this.id = null;
    this.dirty = 0;
    this.notes = {};
    await this.client.delete(`/edits/${id}`, { lifecycle: true, throwOnError: false });
    this.log?.change({ resource: "edit", id, action: "discard", applied: true });
  }
}
