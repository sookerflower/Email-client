import {
  clearIndex,
  countIndexedThreads,
  countThreadsByLabels,
  deleteIndexedThread,
  deleteSpamThreads,
  findThreads,
  getAllSubjects,
  getIndexSizeBytes,
  getIndexedThread,
  getRecentSenders,
  getThreadLabels,
  modifyThreadLabels,
  upsertThread,
  getFolderSyncPageToken,
  setFolderSyncPageToken,
  getFolderSyncRow,
  upsertFolderSyncState,
  listThreadIdsByLabel,
  getFolderLedger,
  replaceFolderLedger,
  applyFolderLedgerDelta,
  clearFolderLedger,
  clearFolderSyncData,
  moveLedgerEntry,
  getLedgerRowsForThreads,
  getFolderValidities,
  deleteLedgerRows,
  insertLedgerRowsIfAbsent,
  findOrphanSnoozeThreadIds,
  findOrphanNoteThreadIds,
  type IndexLabel,
} from './mail-index';
import { generateWhatUserCaresAbout, type UserTopic } from './analyze/interests';

/**
 * Labels with no IMAP representation. These are carried forward across a
 * write-through rather than re-derived from the server, because the server
 * cannot report them back.
 *
 * Keep this list SHORT. Every entry is state that a DB wipe destroys and that
 * no other mail client can see. IMPORTANT and MUTE used to live here and were
 * removed for exactly that reason -- nothing derived them and nothing could
 * filter on them.
 *
 * ---------------------------------------------------------------------------
 * SNOOZED IS A KNOWN SPLIT-BRAIN. Decision deferred until after the action
 * matrix; do not "tidy" it before then, and do not assume it behaves like the
 * dead labels above -- it is LIVE state split across two stores that can
 * disagree:
 *
 *   Redis (snoozeStore) drives WAKING     -- unsnoozeSweep acts on listDue()
 *   Postgres (SNOOZED label) drives VISIBILITY -- the Snoozed view is a
 *                                                thread_label query
 *
 * Neither derives from the other; snoozeThreads writes both independently.
 *   - Postgres wiped -> wake times orphaned in Redis. The sweep later
 *     un-snoozes threads that are no longer snoozed. SILENT CORRUPTION, which
 *     is worse than the plain state loss the dead labels caused.
 *   - Redis wiped -> labels persist, threads sit in Snoozed forever, never
 *     waking.
 *
 * Three defensible fixes, all deferred:
 *   1. Postgres authoritative: add a wake_at column beside the label, keep
 *      Redis as a rebuildable scheduling index. Conventional, no split-brain,
 *      but snooze still dies with the DB.
 *   2. Redis authoritative: survives a DB wipe, but makes the cache the
 *      source of truth for user state. Checked 2026-07-31 on the local
 *      compose: maxmemory-policy=noeviction, maxmemory=0, appendonly=yes --
 *      so keys are NOT evictable here and AOF is on. That removes the usual
 *      objection for THIS environment only; docker-compose.prod.yaml sets no
 *      overrides, so verify before relying on it anywhere else.
 *   3. IMAP authoritative: encode the wake time in a keyword
 *      ($zl_snooze_<epoch>). Ugly, and a reschedule is remove-then-add, but
 *      it is the only option consistent with the invariant this workstream
 *      exists to restore, and it survives both wipes.
 *
 * The action matrix's DB-wipe leg must EXCLUDE snooze and say why, or it will
 * assert a guarantee no option currently provides.
 * ---------------------------------------------------------------------------
 */
const INDEX_ONLY_LABELS = new Set(['SNOOZED']);
import { redis } from './services';
import type {
  IGetThreadResponse,
  IGetThreadsResponse,
  MailManager,
  MemberHints,
  MoveReport,
} from './driver/types';
import type { ParsedMessage } from '../types';
import { getThreadBlobStore, threadBlobKey } from './blob-store';
import { publishBeacon } from './beacons';
import { OutgoingMessageType } from '../routes/agent/types';
import type { connection as connectionSchema } from '../db/schema';
import type { CreateDraftData } from './schemas';
import { snoozeStore } from './stores';
import { createDb } from '../db';
import { env } from '../env';

type ConnectionRow = typeof connectionSchema.$inferSelect;
type BroadcastMessage = { type: OutgoingMessageType; [key: string]: unknown };

const maxSyncCount = () => Number(env.THREAD_SYNC_MAX_COUNT || 20);

/**
 * Per-connection mail engine (Phase 3 of MIGRATION-PLAN.md §2).
 *
 * Replaces the `ZeroDriver` Durable Object: same method surface, but a plain
 * class — thread/label index on Postgres (mail-index.ts, no shards), message
 * bodies in the BlobStore, provider access through the MailManager driver
 * (IMAP ops route to the sidecar via the proxy driver). Runs identically on
 * Node and workerd.
 *
 * Concurrency model: instances are memoized per process; `syncInProgress` is
 * an efficiency guard only — correctness comes from idempotent upserts keyed
 * (connection_id, thread_id). Phase 4 adds BullMQ jobId dedup across
 * processes.
 */
export class MailEngine {
  private syncInProgress = new Set<string>();

  private constructor(
    readonly connectionId: string,
    private connection: ConnectionRow,
    private driver: MailManager,
  ) {}

  static async init(connectionId: string): Promise<MailEngine> {
    const { connectionToDriver } = await import('./server-utils');
    const { db } = createDb(env.DATABASE_URL);
    const row = await db.query.connection.findFirst({
      where: (fields, { eq }) => eq(fields.id, connectionId),
    });
    if (!row) throw new Error(`Connection ${connectionId} not found`);
    return new MailEngine(connectionId, row, connectionToDriver(row));
  }

  /**
   * Test/tooling seam: build an engine around an explicit driver instance
   * (e.g. a direct ImapSmtpMailManager in integration tests, bypassing the
   * sidecar RPC hop). Not used in production paths.
   */
  static createWithDriver(
    connectionId: string,
    connection: ConnectionRow,
    driver: MailManager,
  ): MailEngine {
    return new MailEngine(connectionId, connection, driver);
  }

  /**
   * Realtime invalidation hook (Phase 5 §8b): publishes to Redis pub/sub;
   * the Node-only SSE layer (src/node/realtime.ts) relays to clients.
   * Fire-and-forget by design — a lost ping costs latency, never
   * correctness. Call sites MUST sit after the awaited write they announce
   * (publish-after-commit); this method being sync keeps that property:
   * the publish starts strictly after the preceding awaits resolved.
   */
  broadcast(message: BroadcastMessage) {
    void publishBeacon(this.connectionId, message);
  }

  async reloadFolder(folder: string) {
    this.broadcast({ type: OutgoingMessageType.Mail_List, folder });
  }

  // -------------------------------------------------------------------------
  // Driver passthrough (unchanged semantics from ZeroDriver)
  // -------------------------------------------------------------------------

  async normalizeIds(ids: string[]) {
    return this.driver.normalizeIds(ids);
  }

  async sendDraft(id: string, data: Parameters<MailManager['sendDraft']>[1]) {
    return await this.driver.sendDraft(id, data);
  }

  async create(data: Parameters<MailManager['create']>[0]) {
    return await this.driver.create(data);
  }

  async delete(id: string) {
    return await this.driver.delete(id);
  }

  async getEmailAliases() {
    return await this.driver.getEmailAliases();
  }

  async getMessageAttachments(messageId: string) {
    return await this.driver.getMessageAttachments(messageId);
  }

  async getRawEmail(id: string) {
    return await this.driver.getRawEmail(id);
  }

  async rawListThreads(params: {
    folder: string;
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string;
  }): Promise<IGetThreadsResponse> {
    // Label intersection is applied by the driver itself, inside its batch
    // loop. It used to be injected here as a callback, which JSON.stringify
    // dropped at the RPC boundary -- see the note in driver/types.ts.
    return await this.driver.list(params);
  }

  async modifyLabels(threadIds: string[], addLabelIds: string[], removeLabelIds: string[]) {
    return await this.driver.modifyLabels(threadIds, {
      addLabels: addLabelIds,
      removeLabels: removeLabelIds,
    });
  }

  async listHistory<T>(historyId: string) {
    return await this.driver.listHistory<T>(historyId);
  }

  async getUserLabels() {
    return await this.driver.getUserLabels();
  }

  async getLabel(id: string) {
    return await this.driver.getLabel(id);
  }

  async createLabel(params: {
    name: string;
    color?: { backgroundColor: string; textColor: string };
  }) {
    return await this.driver.createLabel(params);
  }

  async bulkDelete(threadIds: string[]) {
    return await this.driver.modifyLabels(threadIds, {
      addLabels: ['TRASH'],
      removeLabels: ['INBOX'],
    });
  }

  async bulkArchive(threadIds: string[]) {
    return await this.driver.modifyLabels(threadIds, { addLabels: [], removeLabels: ['INBOX'] });
  }

  async updateLabel(
    id: string,
    labelData: { name: string; color?: { backgroundColor: string; textColor: string } },
  ) {
    return await this.driver.updateLabel(id, labelData);
  }

  async deleteLabel(id: string) {
    return await this.driver.deleteLabel(id);
  }

  async createDraft(draftData: CreateDraftData) {
    return await this.driver.createDraft(draftData);
  }

  async getDraft(id: string) {
    return await this.driver.getDraft(id);
  }

  async listDrafts(params: { q?: string; maxResults?: number; pageToken?: string }) {
    return await this.driver.listDrafts(params);
  }

  async deleteDraft(id: string) {
    await this.driver.deleteDraft(id);
    await this.reloadFolder('drafts');
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Index operations (Postgres)
  // -------------------------------------------------------------------------

  async getAllSubjects() {
    return await getAllSubjects(this.connectionId);
  }

  async deleteAllSpam() {
    return await deleteSpamThreads(this.connectionId);
  }

  async count() {
    const folders = ['inbox', 'sent', 'spam', 'archive', 'trash'];
    const results = await countThreadsByLabels(
      this.connectionId,
      folders.map((f) => f.toUpperCase()),
    );
    const resultMap = new Map(results.map((r) => [r.labelId, r.count]));
    return folders.map((f) => ({ label: f, count: resultMap.get(f.toUpperCase()) ?? 0 }));
  }

  async getThreadCount() {
    return await countIndexedThreads(this.connectionId);
  }

  /**
   * Permanent delete, GUARDED: EXPUNGE only when the thread is already in
   * Trash on the server; otherwise MOVE it to Trash.
   *
   * The UI only offers this from the Bin ("Delete from Bin", and the delete
   * hotkey branches on folder === 'bin'), so the guard changes nothing users
   * can currently do. It exists because the procedure is reachable
   * independently of that UI -- a chat tool or a new shortcut added later
   * would otherwise get an irreversible action from a surface that never
   * considered it. Cheap insurance against a caller that has not thought
   * about it.
   *
   * Previously this deleted the INDEX ROW only, which was not deletion at
   * all: the message stayed on the server and came back on the next full
   * resync.
   */
  async deleteThread(id: string) {
    const folders = this.driver.getThreadFolders
      ? await this.driver.getThreadFolders([id])
      : {};
    const inTrash = (folders[id] ?? []).includes('TRASH');

    if (!inTrash) {
      // Not in the bin yet -- this is a move, not a destruction.
      return await this.applyLabels([id], ['TRASH'], []);
    }

    await this.driver.delete(id); // real IMAP expunge across every folder
    await deleteIndexedThread(this.connectionId, id);
    this.broadcast({ type: OutgoingMessageType.Mail_List, folder: 'trash' });
    return { success: true as const };
  }

  normalizeFolderName(folderName: string) {
    return folderName === 'bin' ? 'trash' : folderName;
  }

  async getThreadsFromDB(params: {
    labelIds?: string[];
    folder?: string;
    q?: string;
    maxResults?: number;
    pageToken?: string;
  }): Promise<IGetThreadsResponse> {
    const maxResults = params.maxResults ?? 50;
    const folder = params.folder ? this.normalizeFolderName(params.folder) : undefined;

    // Folder membership is label membership; combining folder + explicit
    // labels requires all of them (parity with the DO queryThreads cases).
    const labelIds = [...(params.labelIds ?? [])];
    if (folder) labelIds.push(folder.toUpperCase());

    const result = await findThreads(this.connectionId, {
      labelIds,
      searchText: params.q,
      pageToken: params.pageToken,
      maxResults,
      requireAllLabels: labelIds.length > 1,
    });

    return {
      threads: result.threads.map((t) => ({ id: t.id, historyId: null })),
      nextPageToken: result.nextPageToken,
    };
  }

  async listThreads(params: {
    folder: string;
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string;
  }) {
    return await this.getThreadsFromDB(params);
  }

  async list(params: {
    folder: string;
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string;
  }) {
    return await this.getThreadsFromDB(params);
  }

  async getThreadFromDB(id: string, includeDrafts = false): Promise<IGetThreadResponse> {
    const indexed = await getIndexedThread(this.connectionId, id);
    if (!indexed) {
      await this.syncThread({ threadId: id });
      // Re-read after sync so a first-time open returns content immediately
      // (the DO version returned empty and relied on a client refetch).
      const synced = await getIndexedThread(this.connectionId, id);
      if (!synced) {
        return {
          messages: [],
          latest: undefined,
          hasUnread: false,
          totalReplies: 0,
          labels: [],
        } satisfies IGetThreadResponse;
      }
    }

    const storedThread = await getThreadBlobStore().get(threadBlobKey(this.connectionId, id));
    let messages: ParsedMessage[] = storedThread
      ? (JSON.parse(storedThread) as IGetThreadResponse).messages
      : [];

    const isLatestDraft = messages.some((e) => e.isDraft === true);
    if (!includeDrafts) messages = messages.filter((e) => e.isDraft !== true);

    const labelsList: IndexLabel[] = await getThreadLabels(this.connectionId, id);
    const labelIds = labelsList.map((l) => l.id);

    // FLAGS ARE MUTABLE STATE AND MUST NEVER BE READ FROM THE BLOB.
    //
    // The blob is an IMMUTABLE point-in-time CONTENT snapshot, written when a
    // message was last fetched and parsed. Flags are not content: they change
    // constantly and from outside this app. Reading them from the blob is
    // wrong in both directions --
    //   - a local action (star, mark read) updates thread_label and the
    //     server, but never the blob, so the star icon went dark the moment
    //     the optimistic update cleared even though the server was correct;
    //   - an EXTERNAL change (a phone marking mail read) updates thread_label
    //     on the next sync but never the blob, so it was already wrong before
    //     write-through existed.
    // thread_label is re-derived from server flags on every sync, so it is
    // the only source that tracks them. `hasUnread` above already worked this
    // way; per-message tags now do too.
    //
    // Projected THREAD-level, which is safe here: every write path in this app
    // is thread-scoped (toggleStar/markAsRead/modifyLabels all take thread
    // ids), and per-message unread rendering does not exist -- mail-display
    // explicitly strips 'unread'/'inbox' from its chips. Only an external
    // client could create per-message divergence, and this app has no UI to
    // show it.
    //
    // Folder labels stay OUT of `tags` and remain in `labels`: tags carry the
    // flag-like state the chips and star icon render, exactly the set that
    // used to be flag-derived (UNREAD / STARRED / $zl_ user keywords).
    // ensureLabels stores name = id, so system tags keep the 'STARRED' /
    // 'UNREAD' spelling the client matches on. User keywords must shed the
    // '$zl_' prefix or the chips would render "$zl_work" where the
    // blob-derived path showed "work".
    const tagLabels = labelsList
      .filter((l) => l.id === 'UNREAD' || l.id === 'STARRED' || l.id.startsWith('$zl_'))
      .map((l) => ({
        id: l.id,
        name: l.id.startsWith('$zl_') ? (l.name || l.id).replace(/^\$zl_/, '') : l.name,
        type: l.id.startsWith('$zl_') ? 'user' : 'system',
      }));
    messages = messages.map((m) => ({ ...m, tags: tagLabels }));

    return {
      messages,
      latest: messages.findLast((e) => e.isDraft !== true),
      hasUnread: labelIds.includes('UNREAD'),
      totalReplies: messages.filter((e) => e.isDraft !== true).length,
      labels: labelsList,
      isLatestDraft,
    } satisfies IGetThreadResponse;
  }

  async getThread(threadId: string, includeDrafts = false) {
    return await this.getThreadFromDB(threadId, includeDrafts);
  }

  async get(id: string) {
    return await this.getThreadFromDB(id);
  }

  /**
   * WRITE-THROUGH label mutation. This is the path every user action must
   * take.
   *
   * Order is load-bearing:
   *   1. write to IMAP (the source of truth) and let failures propagate, so
   *      the client can roll its optimistic update back. Before this existed
   *      every mutation was a Postgres write that could not meaningfully
   *      fail, so there was no error for the UI to react to.
   *   2. re-read what the SERVER now reports -- flags via syncThread, folder
   *      membership via getThreadFolders -- and rebuild the index from that,
   *      never from the labels we intended to write.
   *
   * That second point is the whole invariant: Postgres must stay re-derivable
   * from IMAP. Updating the index from intent is what produced stars and
   * TRASH labels the server had never heard of, which then vanished on the
   * next forced resync.
   *
   * SNOOZED has no IMAP representation and stays index-only by design; the
   * INBOX removal that accompanies it does go to the server.
   */
  async applyLabels(threadIds: string[], addLabels: string[], removeLabels: string[]) {
    if (!threadIds.length) return { success: false as const, error: 'no thread ids' };

    // 0. Ledger hints (item C): hand the driver the folder_message view of
    // these threads so it can STORE/MOVE at known uids instead of paying a
    // WAN search per folder kind. The driver VERIFIES the hints against the
    // server and falls back per thread when they don't hold.
    const hints = await this.buildMemberHints(threadIds);

    // 1. Server first. Any driver/IMAP failure throws out of here.
    const report = (await this.driver.modifyLabels(
      threadIds,
      { addLabels, removeLabels },
      hints,
    )) as MoveReport | undefined;

    // 1b. A MOVE assigns a NEW uid in the destination and expunges the source,
    // so the folder_message ledger has to follow it or it holds a uid that no
    // longer exists. UIDPLUS gives us the exact source->destination mapping,
    // so apply it directly rather than re-fetching and inferring.
    for (const move of report?.moves ?? []) {
      for (const [sourceUid, destUid] of move.uidMap) {
        await moveLedgerEntry(this.connectionId, move.from, sourceUid, move.to, destUid);
      }
    }

    // 1c. Ledger repair from the driver's verification (item C). Rows PROVEN
    // wrong go away now, not at the next sync; members the fallback found in
    // validity-anchored folders are re-seeded. Without the re-seed, one
    // external move would make every later action on the thread pay the
    // search cost until a sync happened to correct the ledger. Awaited for
    // the same reason the move-follow above is: vanish processing reads the
    // ledger, and a deferred repair reopens that race.
    const resolution = report?.resolution;
    if (resolution) {
      if (resolution.fallback.length) {
        // Loud on purpose: a fallback that fires constantly means the ledger
        // is systematically wrong, and that must show in the log, not as a
        // silent latency regression.
        console.warn(
          `[MailEngine:${this.connectionId}] modifyLabels ledger fallback (${resolution.mode}) for ${resolution.fallback
            .map((f) => `${f.threadId}(${f.reason})`)
            .join(', ')} (add=[${addLabels.join(',')}], remove=[${removeLabels.join(',')}])`,
        );
      }
      if (resolution.staleRows.length) {
        await deleteLedgerRows(this.connectionId, resolution.staleRows);
      }
      if (resolution.discovered.length) {
        await insertLedgerRowsIfAbsent(this.connectionId, resolution.discovered);
      }
    }

    // 2a. AWAITED fast index commit (order-probe ruling, option iii).
    //
    // 4e6d5ba1 moved the whole index rebuild off the request path, which
    // silently widened publish-after-commit into publish-after-SERVER-commit:
    // the mutation acked (and beacons from OTHER publishers -- e.g. the
    // worker's IDLE-triggered sync reacting to our own STORE -- could land)
    // seconds before the index held the changed labels, so a client acting
    // on a beacon read pre-mutation state. e2e-realtime's order-probe leg
    // caught exactly this.
    //
    // The fix commits ONLY the mutated labels to the index before returning;
    // the full folder re-derivation below stays in the background. This is
    // within applyIndexLabelsFromSync's sync-side contract: the server write
    // in step 1 already happened, the index is catching up to it. Cost is a
    // few Postgres statements per thread (measured, see commit message) --
    // the expensive part 4e6d5ba1 deferred (getThreadFolders + driver.get
    // refreshes, sequential IMAP round trips) stays deferred.
    for (const threadId of threadIds) {
      await this.applyIndexLabelsFromSync(threadId, addLabels, removeLabels);
    }

    // 2. Rebuild the index from server truth -- as a BACKGROUND CONTINUATION.
    //
    // The caller stops waiting HERE. Measured cost of what follows on
    // localhost alone: getThreadFolders ~280ms + driver.get-backed refresh
    // ~300ms per thread, all sequential IMAP round-trips -- it pushed every
    // user action to ~1.1s locally and 1.5-2.5s against the real server,
    // which users see as a 1-2s lag on every star/read/archive.
    //
    // What this does NOT change: the ordering invariant. The IMAP write above
    // is still first and still awaited (its failure rolls the client back);
    // the LEDGER update above is still awaited (the vanish path reads it, so
    // deferring it would reopen the move race item 3 closed); the index is
    // still rebuilt from what the server reports, never from intent. The only
    // change is that the CALLER no longer waits for the re-derivation --
    // which was already the documented failure contract ("index refresh
    // failure -> next sync converges").
    //
    // Un-awaited work that throws is invisible, and an invisible failure here
    // is exactly the shape that caused the syncThread bare-success race. So
    // the continuation logs EVERY failure loudly, per thread, with the
    // operation -- systematic breakage must show in the log, not as
    // mysterious stale data.
    void this.refreshIndexAfterLabels(threadIds, addLabels, removeLabels).catch((error) => {
      console.error(
        `[MailEngine:${this.connectionId}] applyLabels CONTINUATION FAILED wholesale for [${threadIds.join(',')}] (add=[${addLabels.join(',')}], remove=[${removeLabels.join(',')}]): ${error instanceof Error ? error.message : error}`,
      );
    });

    // `resolution` rides along so tests can assert HOW members were resolved
    // -- a fallback that never fires is indistinguishable from one that does
    // by end state alone.
    return { success: true as const, resolution };
  }

  /**
   * Ledger-derived member hints for driver.modifyLabels (item C).
   *
   * The awaited cost of every user action used to be resolveThreadMembers
   * searching six folder kinds over the WAN (~12 round trips against the
   * real server). folder_message already maps thread -> (folder, uid) in
   * ~1ms of Postgres, so hand the driver those uids -- but only where the
   * ledger can be held to account:
   *
   *   - a thread is included only when the ledger fully accounts for the
   *     index's own view of it (every blob message has a row, no drafts --
   *     drafts are never ledgered). A partially-covered thread would
   *     silently act on SOME members, which is worse than being slow;
   *   - rows are only usable in folders whose UIDVALIDITY is on record
   *     (synced folders: inbox and sent today). Rows this engine wrote by
   *     following its own moves into never-synced folders (trash/spam/
   *     archive) have no validity anchor and no sync ever corrects them,
   *     so those threads deliberately keep the search path;
   *   - the driver re-verifies everything live (folder validity + per-uid
   *     existence, from the STORE/MOVE responses) and reports what was
   *     wrong, so applyLabels can repair the ledger (see step 1c).
   *
   * Returns undefined for oversized batches: bulk actions are not the
   * latency-sensitive path, and the per-thread blob reads are not free.
   * Never throws -- hints are an optimization, not a dependency.
   */
  private async buildMemberHints(threadIds: string[]): Promise<MemberHints | undefined> {
    if (threadIds.length === 0 || threadIds.length > 20) return undefined;
    try {
      const validity = await getFolderValidities(this.connectionId);
      const rows = await getLedgerRowsForThreads(this.connectionId, threadIds);
      const byThread = new Map<string, { folder: string; uid: number }[]>();
      for (const r of rows) {
        let list = byThread.get(r.threadId);
        if (!list) byThread.set(r.threadId, (list = []));
        list.push({ folder: r.folder, uid: r.uid });
      }

      const threads: MemberHints['threads'] = {};
      for (const tid of threadIds) {
        const list = byThread.get(tid);
        if (!list?.length) continue;
        if (!list.every((r) => validity[r.folder] != null)) continue;
        const blob = await getThreadBlobStore().get(threadBlobKey(this.connectionId, tid));
        if (!blob) continue;
        let messages: { isDraft?: boolean }[];
        try {
          messages = (JSON.parse(blob) as IGetThreadResponse).messages ?? [];
        } catch {
          continue;
        }
        if (messages.some((m) => m.isDraft === true)) continue;
        if (list.length < messages.length) continue;
        threads[tid] = list;
      }
      return { threads, validity };
    } catch (error) {
      console.warn(
        `[MailEngine:${this.connectionId}] buildMemberHints failed (falling back to search): ${error instanceof Error ? error.message : error}`,
      );
      return undefined;
    }
  }

  /**
   * The deferred half of applyLabels: read back server truth and rebuild the
   * index. Runs un-awaited after the IMAP write and ledger update commit.
   * Broadcasts fire at the END, so clients refetch only once the index is
   * actually fresh.
   */
  private async refreshIndexAfterLabels(
    threadIds: string[],
    addLabels: string[],
    removeLabels: string[],
  ) {
    const folders = this.driver.getThreadFolders
      ? await this.driver.getThreadFolders(threadIds)
      : {};

    for (const threadId of threadIds) {
      const serverFolders = folders[threadId] ?? [];
      const currentLabels = (await getThreadLabels(this.connectionId, threadId)).map((l) => l.id);
      // Index-only labels the server cannot represent are carried forward
      // deliberately, not re-derived.
      const keptIndexOnly = currentLabels
        .filter((id) => INDEX_ONLY_LABELS.has(id) && !removeLabels.includes(id))
        .concat(addLabels.filter((id) => INDEX_ONLY_LABELS.has(id)));

      const extraLabelIds = [...new Set([...serverFolders, ...keptIndexOnly])];
      // If a folder sync already has this thread in flight, syncThread
      // dedup-skips -- and a skipped refresh here means the flags we just
      // wrote never reach the index (the in-flight sync fetched its flags
      // before our write). Wait out the in-flight sync and refresh for real;
      // it clears in seconds.
      let synced = await this.syncThread({ threadId, extraLabelIds });
      for (let attempt = 0; synced.skipped && attempt < 10; attempt++) {
        await new Promise((r) => setTimeout(r, 700));
        synced = await this.syncThread({ threadId, extraLabelIds });
      }
      if (synced.skipped) {
        console.error(
          `[MailEngine:${this.connectionId}] applyLabels: sync still in flight for ${threadId} after 10 waits; index refresh deferred to the next folder sync`,
        );
      }

      // Folder-label reconciliation from server truth, on BOTH branches.
      // upsertThread's folder labels are add-only (each folder's own sync
      // contributes its label), so a successful syncThread ADDS the new
      // folder but never drops the old one -- on first execution, archive
      // left INBOX behind and not-spam left SPAM behind. Restricted to the
      // folders getThreadFolders actually reports (INBOX/ARCHIVE/SPAM/TRASH):
      // SENT and DRAFTS are outside its vision, so "not reported" proves
      // nothing about them and dropping them here would be wrong.
      const folderLabelsToDrop = currentLabels.filter(
        (id) => MailEngine.MOVE_FOLDER_LABELS.has(id) && !serverFolders.includes(id),
      );

      if (synced.success) {
        if (folderLabelsToDrop.length) {
          await this.applyIndexLabelsFromSync(threadId, [], folderLabelsToDrop);
        }
      } else {
        // Index-only catch-up from the server-reported folder set. The
        // server already performed the mutation; the blob keeps its
        // parse-time content, which a move does not change.
        const toAdd = extraLabelIds.filter((id) => !currentLabels.includes(id));
        await this.applyIndexLabelsFromSync(threadId, toAdd, folderLabelsToDrop);
        if (synced.reason !== 'No latest message') {
          // Server write succeeded; only the index refresh failed. The next
          // sync converges -- but say so LOUDLY, per thread.
          console.error(
            `[MailEngine:${this.connectionId}] applyLabels continuation: index refresh failed for ${threadId} (add=[${addLabels.join(',')}], remove=[${removeLabels.join(',')}]): ${synced.reason}; folder labels reconciled, next sync converges`,
          );
        }
      }
    }

    const affected = [...new Set([...addLabels, ...removeLabels])];
    for (const l of affected) await this.reloadFolder(l.toLowerCase());
    for (const threadId of threadIds) {
      this.broadcast({ type: OutgoingMessageType.Mail_Get, threadId });
    }
  }

  /**
   * INDEX-ONLY label write. SYNC-SIDE USE ONLY.
   *
   * Legitimate when the change ALREADY HAPPENED on the server and the index
   * is catching up -- e.g. a thread vanished from a folder during an
   * incremental sync and we drop that folder's label. Writing back to IMAP
   * there would be wrong (and circular).
   *
   * NEVER call this for a user action. It is the old `modifyThreadLabelsInDB`,
   * renamed so the sync-only contract is unmissable: as a general-purpose
   * mutation path it produced index state the server had never heard of,
   * which reverted on forced resync and died with a DB wipe. User actions go
   * through `applyLabels` (write-through).
   */
  async applyIndexLabelsFromSync(threadId: string, addLabels: string[], removeLabels: string[]) {
    const currentLabelsData = await getThreadLabels(this.connectionId, threadId);
    const currentLabels = currentLabelsData.map((l) => l.id);

    const result = await modifyThreadLabels(this.connectionId, threadId, addLabels, removeLabels);

    const allAffectedLabels = [...new Set([...addLabels, ...removeLabels])];
    for (const l of allAffectedLabels) await this.reloadFolder(l.toLowerCase());
    this.broadcast({ type: OutgoingMessageType.Mail_Get, threadId });

    return {
      success: true,
      threadId,
      previousLabels: currentLabels,
      addedLabels: result.addedLabels,
      removedLabels: result.removedLabels,
    };
  }

  async modifyThreadLabelsByName(
    threadId: string,
    addLabelNames: string[],
    removeLabelNames: string[],
  ) {
    const userLabels = await this.getUserLabels();
    const labelMap = new Map(userLabels.map((l) => [l.name.toLowerCase(), l.id]));

    const resolve = (names: string[]) =>
      names
        .map((name) => {
          const id = labelMap.get(name.toLowerCase());
          if (!id) console.warn(`Label "${name}" not found in user labels`);
          return id;
        })
        .filter((id): id is string => !!id);

    // Write-through: this is a user-facing path, not a sync-side one.
    return await this.applyLabels(
      [threadId],
      resolve(addLabelNames),
      resolve(removeLabelNames),
    );
  }

  async storeThreadInDB(
    threadData: {
      id: string;
      threadId: string;
      providerId: string;
      latestSender: unknown;
      latestReceivedOn: string;
      latestSubject: string;
    },
    labelIds: string[],
  ): Promise<void> {
    await upsertThread(
      this.connectionId,
      {
        threadId: threadData.threadId,
        providerId: threadData.providerId,
        latestSender: threadData.latestSender,
        latestReceivedOn: threadData.latestReceivedOn,
        latestSubject: threadData.latestSubject,
      },
      labelIds,
    );
  }

  // -------------------------------------------------------------------------
  // Sync (in-process for Phase 3; Phase 4 wraps these in BullMQ jobs)
  // -------------------------------------------------------------------------

  async syncThread({
    threadId,
    extraLabelIds = [],
  }: {
    threadId: string;
    /**
     * Folder label(s) to attach in addition to message tags. The IMAP
     * driver's per-message tags carry flags (UNREAD/STARRED/keywords) but
     * not folder membership — the folder is only known by whoever listed it,
     * so folder-driven syncs must pass it in. (Latent in the DO/workflow
     * version too: it stored tags only, so IMAP threads never got INBOX.)
     */
    extraLabelIds?: string[];
  }): Promise<{
    success: boolean;
    threadId: string;
    reason?: string;
    broadcastSent: boolean;
    /** True when dedup-skipped because this thread was already mid-sync. */
    skipped?: boolean;
  }> {
    if (this.syncInProgress.has(threadId)) {
      // DEDUP SKIP, and the caller must be able to see it. This used to
      // return bare success, and applyLabels trusted it: a write-through's
      // post-write refresh that landed while a folder sync had this thread
      // in flight would no-op silently -- and the concurrent sync's own
      // upsert used flags fetched BEFORE the write, so a just-set \Flagged
      // ended up on the server but never in the index (found live on Dovecot:
      // star SET passed at SERVER and failed at app+index, nondeterministic
      // across runs because it is a race with syncFolderOnce).
      return { success: true, threadId, broadcastSent: false, skipped: true };
    }
    this.syncInProgress.add(threadId);
    try {
      const thread = await this.driver.get(threadId);
      const latest = thread.latest;
      if (!latest) {
        return { success: false, threadId, reason: 'No latest message', broadcastSent: false };
      }

      await getThreadBlobStore().put(
        threadBlobKey(this.connectionId, threadId),
        JSON.stringify(thread),
      );

      let normalizedReceivedOn: string;
      try {
        normalizedReceivedOn = new Date(latest.receivedOn).toISOString();
      } catch {
        normalizedReceivedOn = new Date().toISOString();
      }

      await upsertThread(
        this.connectionId,
        {
          threadId,
          providerId: this.connection.providerId,
          latestSender: latest.sender,
          latestReceivedOn: normalizedReceivedOn,
          latestSubject: latest.subject,
        },
        [...new Set([...(latest.tags?.map((tag) => tag.id) ?? []), ...extraLabelIds])],
      );

      this.broadcast({ type: OutgoingMessageType.Mail_Get, threadId });
      return { success: true, threadId, broadcastSent: true };
    } catch (error) {
      console.error(`[MailEngine] Failed to sync thread ${threadId}:`, error);
      return {
        success: false,
        threadId,
        reason: error instanceof Error ? error.message : String(error),
        broadcastSent: false,
      };
    } finally {
      this.syncInProgress.delete(threadId);
    }
  }

  /**
   * One bounded sync pass over a folder: list the most recent page from the
   * provider and sync each thread with small concurrency (fail2ban-safe: the
   * driver multiplexes over the sidecar's single working connection).
   * Port of SyncThreadsWorkflow's page processing, minus the workflow.
   */
  async syncFolderOnce(folder: string): Promise<{ synced: number; total: number }> {
    const listing = await this.driver.list({ folder, maxResults: maxSyncCount() });
    const ids = listing.threads.map((t) => t.id);
    const folderLabel = this.normalizeFolderName(folder).toUpperCase();

    let synced = 0;
    const concurrency = 3;
    for (let i = 0; i < ids.length; i += concurrency) {
      const batch = ids.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map((id) => this.syncThread({ threadId: id, extraLabelIds: [folderLabel] })),
      );
      synced += results.filter((r) => r.status === 'fulfilled' && r.value.success).length;
    }

    await this.reloadFolder(folder);
    console.log(`[MailEngine:${this.connectionId}] syncFolderOnce(${folder}): ${synced}/${ids.length}`);
    return { synced, total: ids.length };
  }

  /**
   * Job-mode folder sync (Phase 4 §3): sequential page loop with the
   * pageToken checkpointed to folder_sync_state after every completed page,
   * so a BullMQ retry resumes where the failed attempt stopped instead of
   * restarting. Per-thread concurrency stays bounded at 3 (fail2ban-safe —
   * do not raise). Errors are RETHROWN so the queue's retry policy is real;
   * the in-flight page is redone on retry, which is safe because thread
   * upserts are idempotent.
   */
  async syncFolderJob(
    folder: string,
    opts?: { resume?: boolean },
  ): Promise<{ synced: number; total: number; pages: number }> {
    const pageSize = 20;
    const maxTotal = maxSyncCount();
    const folderLabel = this.normalizeFolderName(folder).toUpperCase();

    // ------------------------------------------------------------------
    // UIDVALIDITY guard (Phase 6.1, MIGRATION-PLAN §9.1). A validity
    // change means every cached UID for this folder may point at a
    // DIFFERENT message — the one failure mode that corrupts caches
    // silently. On change: purge the folder's threads (index + blobs),
    // discard all cached sync state, and resync from scratch. Runs before
    // the incremental ladder (6.2) exists so the ladder is born safe.
    // ------------------------------------------------------------------
    const folderState = await this.driver.getFolderState?.(folder).catch((error) => {
      // State probe failure must not block sync; the guard just can't
      // engage this round (full-refetch semantics stay safe regardless).
      console.warn(
        `[MailEngine:${this.connectionId}] getFolderState(${folder}) failed:`,
        (error as Error).message,
      );
      return null;
    });
    const stored = await getFolderSyncRow(this.connectionId, folder);
    let guardTripped = false;
    let resyncCount = 0;
    if (
      folderState?.uidValidity != null &&
      stored?.uidValidity != null &&
      stored.uidValidity !== folderState.uidValidity
    ) {
      // Flap protection (the Nylas lesson): consecutive validity-triggered
      // resyncs are capped; the counter ages out after an hour of quiet.
      const staleWindow = Date.now() - new Date(stored.updatedAt).getTime() > 60 * 60 * 1000;
      const attempts = staleWindow ? 0 : (stored.resyncCount ?? 0);
      const MAX_VALIDITY_RESYNCS = 3;
      if (attempts >= MAX_VALIDITY_RESYNCS) {
        throw new Error(
          `UIDVALIDITY for ${folder} is flapping (${stored.uidValidity} -> ${folderState.uidValidity}, ` +
            `${attempts} consecutive resyncs) — refusing to resync-loop; will retry after the cooldown window`,
        );
      }
      guardTripped = true;
      resyncCount = attempts + 1;
      console.warn(
        `[MailEngine:${this.connectionId}] UIDVALIDITY changed for ${folder}: ` +
          `${stored.uidValidity} -> ${folderState.uidValidity} — purging folder cache, full resync (${resyncCount}/${MAX_VALIDITY_RESYNCS})`,
      );
      const staleThreadIds = await listThreadIdsByLabel(this.connectionId, folderLabel);
      for (const threadId of staleThreadIds) {
        await deleteIndexedThread(this.connectionId, threadId);
        await getThreadBlobStore()
          .delete(threadBlobKey(this.connectionId, threadId))
          .catch(() => undefined);
      }
      // A validity change invalidates the ladder's cursors AND ledger —
      // resuming QRESYNC/CONDSTORE state against a new validity is exactly
      // the corruption this guard exists to prevent.
      await clearFolderLedger(this.connectionId, folder);
      // Persist the new validity and wipe cached cursors BEFORE syncing so
      // a mid-sync retry doesn't re-trip the guard (and re-purge).
      await upsertFolderSyncState(this.connectionId, folder, {
        uidValidity: folderState.uidValidity,
        uidNext: null,
        highestModseq: null,
        pageToken: null,
        resyncCount,
      });
      console.log(
        `[MailEngine:${this.connectionId}] purged ${staleThreadIds.length} ${folderLabel} thread(s) after UIDVALIDITY change`,
      );
    }
    // ------------------------------------------------------------------
    // Incremental ladder (Phase 6.2, MIGRATION-PLAN §9.1): when a cursor
    // from a prior completed sync exists (and the guard didn't just wipe
    // it), sync only what changed — condstore rung or uid-diff floor,
    // chosen by the driver from server capabilities. Correctness bar: the
    // result must be indistinguishable from a from-scratch full resync
    // (the incremental-equivalence E2E oracle), including deletions.
    // ------------------------------------------------------------------
    const canIncremental =
      !guardTripped &&
      typeof this.driver.fetchFolderDelta === 'function' &&
      stored?.uidValidity != null &&
      stored?.uidNext != null &&
      folderState?.uidValidity != null &&
      stored.pageToken == null; // a mid-full-sync checkpoint finishes as full

    if (canIncremental) {
      const started = Date.now();
      const ledger = await getFolderLedger(this.connectionId, folder);
      // Bounded flags sweep: the newest window of known UIDs only.
      const known = ledger
        .slice()
        .sort((a, b) => b.uid - a.uid)
        .slice(0, maxTotal)
        .map(({ uid, flags }) => ({ uid, flags }));
      // Non-null: canIncremental established both fields above.
      const delta = await this.driver.fetchFolderDelta!(folder, {
        uidValidity: stored!.uidValidity!,
        uidNext: stored!.uidNext!,
        highestModseq: stored?.highestModseq ?? null,
        known,
      });

      if (delta && !delta.fullResyncRequired) {
        const ledgerByUid = new Map(ledger.map((e) => [e.uid, e]));
        const vanishedThreadIds = new Set(
          delta.vanishedUids
            .map((uid) => ledgerByUid.get(uid)?.threadId)
            .filter((id): id is string => !!id),
        );
        const changedThreadIds = new Set(delta.messages.map((m) => m.threadId));
        const affected = [...new Set([...changedThreadIds, ...vanishedThreadIds])];

        let synced = 0;
        let removed = 0;
        const concurrency = 3;
        for (let i = 0; i < affected.length; i += concurrency) {
          const batch = affected.slice(i, i + concurrency);
          const results = await Promise.all(
            batch.map((threadId) =>
              this.resyncOrRemoveThread(threadId, folderLabel, {
                stillInFolder: changedThreadIds.has(threadId),
              }),
            ),
          );
          synced += results.filter((r) => r.success && !r.removed).length;
          removed += results.filter((r) => r.removed).length;
          const failed = results.filter((r) => !r.success);
          if (failed.length) {
            throw new Error(
              `syncFolderJob(${folder}) incremental: ${failed.length}/${batch.length} thread syncs failed — first: ${failed[0]?.reason ?? 'unknown'}`,
            );
          }
        }

        await applyFolderLedgerDelta(this.connectionId, folder, {
          vanishedUids: delta.vanishedUids,
          messages: delta.messages,
        });
        await upsertFolderSyncState(this.connectionId, folder, {
          uidValidity: delta.newCursor.uidValidity,
          uidNext: delta.newCursor.uidNext,
          highestModseq: delta.newCursor.highestModseq,
          pageToken: null,
          lastSyncedAt: new Date(),
          resyncCount: 0,
          syncMode: delta.mode,
        });
        await this.reloadFolder(folder);
        console.log(
          `[MailEngine:${this.connectionId}] syncFolderJob(${folder}) [${delta.mode}]: ` +
            `${synced} synced, ${removed} removed, ${delta.vanishedUids.length} vanished uid(s) in ${Date.now() - started}ms`,
        );
        return { synced, total: affected.length, pages: 0 };
      }
      console.warn(
        `[MailEngine:${this.connectionId}] syncFolderJob(${folder}): incremental unavailable (${delta ? 'validity mismatch' : 'no delta'}) — falling back to full`,
      );
    }

    // Resume only applies to a RETRY of the same job. A fresh job honoring a
    // stale checkpoint (left by a job that exhausted its retries or died
    // with the process) would start mid-listing and skip the newest page —
    // exactly the mail a fresh sync exists to fetch.
    let pageToken: string | undefined;
    if (opts?.resume) {
      pageToken = (await getFolderSyncPageToken(this.connectionId, folder)) ?? undefined;
      if (pageToken) {
        console.log(
          `[MailEngine:${this.connectionId}] syncFolderJob(${folder}): retry resuming at pageToken ${pageToken}`,
        );
      }
    } else {
      await setFolderSyncPageToken(this.connectionId, folder, null);
    }

    let synced = 0;
    let total = 0;
    let pages = 0;
    for (;;) {
      const listing = await this.driver.list({ folder, maxResults: pageSize, pageToken });
      const ids = listing.threads.map((t) => t.id);
      total += ids.length;
      pages += 1;

      const concurrency = 3;
      for (let i = 0; i < ids.length; i += concurrency) {
        const batch = ids.slice(i, i + concurrency);
        const results = await Promise.all(
          batch.map((id) => this.syncThread({ threadId: id, extraLabelIds: [folderLabel] })),
        );
        synced += results.filter((r) => r.success).length;
        // "No latest message" is a data condition (e.g. thread emptied
        // between list and get), not a transient error — skip it, don't
        // fail the job over it. Everything else is converted to a thrown
        // error so BullMQ retries (checkpoint still points at this page).
        const skipped = results.filter((r) => !r.success && r.reason === 'No latest message');
        if (skipped.length) {
          console.warn(
            `[MailEngine:${this.connectionId}] syncFolderJob(${folder}) page ${pages}: skipped ${skipped.length} empty thread(s)`,
          );
        }
        const failed = results.filter((r) => !r.success && r.reason !== 'No latest message');
        if (failed.length) {
          throw new Error(
            `syncFolderJob(${folder}) page ${pages}: ${failed.length}/${batch.length} thread syncs failed — first: ${failed[0]?.reason ?? 'unknown'}`,
          );
        }
      }

      const next = listing.nextPageToken ?? null;
      if (!next || Number(next) >= maxTotal) {
        // Completed full run: rebuild the UID ledger from a window snapshot
        // (the incremental path's deletion detection depends on it) and
        // record the cursor this sync was built against. The cursor uses
        // the PRE-LISTING folder state (probed at sync start) with the
        // post-sync snapshot only as fallback: a message arriving between
        // the listing and the snapshot would otherwise be ledgered with the
        // cursor advanced past it and NEVER INDEXED — observed live in the
        // 6.5 fresh-resync drill (probe uid in ledger, uid_next beyond it,
        // no thread row). An older cursor merely re-fetches the tail on the
        // next incremental; upserts are idempotent.
        const snapshot = await this.driver
          .fetchFolderDelta?.(folder, null, maxTotal)
          .catch(() => null);
        if (snapshot) {
          await replaceFolderLedger(this.connectionId, folder, snapshot.messages);
        }
        await upsertFolderSyncState(this.connectionId, folder, {
          uidValidity:
            folderState?.uidValidity ??
            snapshot?.newCursor.uidValidity ??
            stored?.uidValidity ??
            null,
          uidNext: folderState?.uidNext ?? snapshot?.newCursor.uidNext ?? null,
          highestModseq: folderState?.highestModseq ?? snapshot?.newCursor.highestModseq ?? null,
          pageToken: null,
          lastSyncedAt: new Date(),
          resyncCount: guardTripped ? resyncCount : 0,
          syncMode: 'full',
        });
        break;
      }
      await setFolderSyncPageToken(this.connectionId, folder, next);
      pageToken = next;
    }

    await this.reloadFolder(folder);
    console.log(
      `[MailEngine:${this.connectionId}] syncFolderJob(${folder}): ${synced}/${total} over ${pages} page(s)`,
    );
    return { synced, total, pages };
  }

  /**
   * Incremental-path thread refresh (Phase 6.2): re-sync a changed thread,
   * or REMOVE it when its messages are gone (the deletion case a sync that
   * only adds can never converge on). A vanished-from-this-folder thread
   * that survives elsewhere keeps its OTHER folder labels but loses this
   * one — matching what a from-scratch resync would produce.
   */
  private static readonly FOLDER_LABELS = new Set([
    'INBOX',
    'SENT',
    'ARCHIVE',
    'DRAFT',
    'DRAFTS',
    'SPAM',
    'TRASH',
    'BIN',
    'SNOOZED',
  ]);

  /**
   * The folder labels getThreadFolders can actually observe -- the only set
   * write-through reconciliation may DROP from. SENT/DRAFTS are invisible to
   * it, so their absence from a server report proves nothing.
   */
  private static readonly MOVE_FOLDER_LABELS = new Set(['INBOX', 'ARCHIVE', 'SPAM', 'TRASH']);

  private async resyncOrRemoveThread(
    threadId: string,
    folderLabel: string,
    opts: { stillInFolder: boolean },
  ): Promise<{ success: boolean; removed?: boolean; reason?: string }> {
    let extraLabelIds: string[];
    if (opts.stillInFolder) {
      extraLabelIds = [folderLabel];
    } else {
      // Vanished from this folder: preserve the thread's other folder
      // memberships, drop this one; message tags are re-derived fresh.
      const existing = await getThreadLabels(this.connectionId, threadId);
      extraLabelIds = existing
        .map((l) => l.id)
        .filter((id) => MailEngine.FOLDER_LABELS.has(id) && id !== folderLabel);
    }
    const result = await this.syncThread({ threadId, extraLabelIds });
    if (result.success) return { success: true };
    if (result.reason === 'No latest message') {
      // "No latest message" means the driver found nothing in its MEMBER
      // folders (inbox/sent/archive/drafts) — but trash and junk are
      // deliberately outside that search, so for a binned/spammed thread it
      // does NOT mean gone. Deleting the row here emptied the Bin view the
      // moment an incremental sync followed a BulkDelete (the app-side
      // TRASH move makes the UID vanish from inbox, this path fired, and
      // the thread disappeared from the index entirely — observed live via
      // the chat-hitl leg). Keep the row and its blob; drop only this
      // folder's label, exactly the vanished-but-alive-elsewhere semantics.
      if (!opts.stillInFolder) {
        const outOfSearch = extraLabelIds.filter(
          (id) => id === 'TRASH' || id === 'BIN' || id === 'SPAM',
        );
        if (outOfSearch.length) {
          // Index-only on purpose: the server already moved this message.
          await this.applyIndexLabelsFromSync(threadId, [], [folderLabel]);
          this.broadcast({ type: OutgoingMessageType.Mail_Get, threadId });
          return { success: true };
        }
      }
      await deleteIndexedThread(this.connectionId, threadId);
      await getThreadBlobStore()
        .delete(threadBlobKey(this.connectionId, threadId))
        .catch(() => undefined);
      this.broadcast({ type: OutgoingMessageType.Mail_Get, threadId });
      return { success: true, removed: true };
    }
    return { success: false, reason: result.reason };
  }

  async syncFolders() {
    const threadCount = await this.getThreadCount();
    if (threadCount < maxSyncCount()) {
      await this.syncFolderOnce('inbox');
    }
  }

  /** External new-mail signal (IMAP sidecar IDLE/poll callback). */
  async notifyNewMail(folder = 'inbox'): Promise<void> {
    // Fire-and-forget; Phase 4 turns this into a debounced BullMQ job.
    void this.syncFolderOnce(folder).catch((error) =>
      console.error(`[MailEngine] notifyNewMail sync failed for ${folder}:`, error),
    );
  }

  private forceReSyncInFlight: Promise<void> | null = null;

  /**
   * COALESCE concurrent cycles — never queue, never interleave.
   *
   * Nothing else can serialize two cycles: the per-account /rpc lock
   * covers one driver METHOD, not a multi-call rebuild (and holding it
   * for a whole cycle would starve every other op on the account). Two
   * interleaved cycles are the 6.2 concurrency shape again — one cycle's
   * clearIndex landing inside the other's rebuild. Proven damage (probe,
   * 2026-08-10, first overlapped pair): cycle B's SNOOZED snapshot read
   * the index in A's post-clear window, saw nothing, judged the snooze
   * "not recoverable" and PRUNED its wake row while the label survived —
   * a thread parked in Snoozed forever that will never wake.
   *
   * A joiner gets the RUNNING cycle's promise instead of a second cycle:
   * back-to-back full rebuilds of an already-correct mailbox are wasted
   * work (coalesce-not-queue ruling). Complete coverage without new lock
   * granularity: every forceReSync caller (explicit route + empty-inbox
   * auto-trigger) resolves through the api process's memoized per-
   * connection engine, and the worker never calls forceReSync.
   */
  forceReSync(): Promise<void> {
    if (this.forceReSyncInFlight) return this.forceReSyncInFlight;
    const run = this.runForceReSync().finally(() => {
      this.forceReSyncInFlight = null;
    });
    this.forceReSyncInFlight = run;
    return run;
  }

  private async runForceReSync() {
    this.syncInProgress.clear();
    // SNOOZED snapshot BEFORE the wipe. SNOOZED is index-only by design
    // (no IMAP representation), so no folder pass below can ever restore
    // it -- without this snapshot a forced resync silently un-snoozed
    // every thread while its wake row survived in mail0_snooze, and the
    // unsnooze sweep then acted on threads the index no longer knew
    // (the split-brain corruption documented at the top of this file).
    const snoozedIds = await listThreadIdsByLabel(this.connectionId, 'SNOOZED');
    await clearIndex(this.connectionId);
    // From-scratch means from scratch: ladder cursors and the UID ledger go
    // with the index, or the next incremental sync would see "no changes"
    // against an empty index and leave it empty.
    await clearFolderSyncData(this.connectionId);
    // Pre-listing folder state, captured BEFORE the sync pass: the recorded
    // cursor must never be newer than the listing it was built from (the
    // mid-sync-arrival residual, same as syncFolderJob's completion block).
    const preState = (await this.driver.getFolderState?.('inbox').catch(() => null)) ?? null;
    await this.syncFolders();
    // Trash and Junk must be rebuilt too, or a from-scratch resync DESTROYS
    // binned/spammed threads: nothing else ever syncs those folders, so
    // their TRASH/SPAM labels and blobs are only re-derivable by listing
    // them here (driver.get's trash/junk fallback fetches the content).
    // First execution of the move path proved it: forceSync dropped a binned
    // thread from the index entirely while the message sat in Trash on the
    // server. Failures are non-fatal -- a fresh account may not have these
    // folders yet.
    await this.syncFolderOnce('bin').catch((error) =>
      console.warn(`[MailEngine:${this.connectionId}] forceReSync bin pass failed:`, error?.message),
    );
    await this.syncFolderOnce('spam').catch((error) =>
      console.warn(`[MailEngine:${this.connectionId}] forceReSync spam pass failed:`, error?.message),
    );
    // Sent and Archive must be rebuilt for the same reason as Trash/Junk
    // above: nothing else re-lists them on the interactive timeline. Before
    // these passes, a forced resync ERASED the Sent view until the next
    // 10-minute repeatable tick, and erased Archive PERMANENTLY -- no code
    // path anywhere re-listed the archive folder, so archived (and snoozed,
    // see below) threads vanished from the app while their messages sat on
    // the server. Same non-fatal shape: a fresh account may lack the folder.
    await this.syncFolderOnce('sent').catch((error) =>
      console.warn(`[MailEngine:${this.connectionId}] forceReSync sent pass failed:`, error?.message),
    );
    await this.syncFolderOnce('archive').catch((error) =>
      console.warn(
        `[MailEngine:${this.connectionId}] forceReSync archive pass failed:`,
        error?.message,
      ),
    );
    // Re-apply SNOOZED to every snapshotted thread the passes above
    // recovered (snoozed messages live in the archive mailbox -- the INBOX
    // removal that accompanies a snooze moves them there -- so the archive
    // pass is what brings their threads back). Index-only catch-up, same
    // contract as the keptIndexOnly carry-forward in the refresh path.
    // Threads that did NOT come back get their wake rows pruned LOUDLY:
    // a wake row without a thread is the orphan the unsnooze sweep would
    // otherwise act on blindly.
    const unrecovered: string[] = [];
    for (const threadId of snoozedIds) {
      const recovered = (await getThreadLabels(this.connectionId, threadId)).length > 0;
      if (recovered) {
        await this.applyIndexLabelsFromSync(threadId, ['SNOOZED'], []);
      } else {
        unrecovered.push(threadId);
      }
    }
    // POSITIVE-evidence gate before the prune (destructive-prune ruling).
    // "Not re-indexed by the passes above" is NOT proof of absence: each
    // pass lists a bounded window (maxSyncCount newest threads), so an
    // archive holding more than the window structurally omits older
    // snoozed messages on ANY server — and on GreenMail the listing can
    // additionally be stale (mailbox.exists reads low right after moves).
    // Ambiguity means KEEP: an orphaned wake row that later fires into
    // nothing is a recoverable nuisance; a pruned live reminder is silent
    // destruction. getThreadFolders is the positive instrument — a
    // server-side member SEARCH per folder kind, independent of listing
    // windows and exists counts, and it THROWS rather than returning
    // empty on failure, so [] after success genuinely means "searched
    // INBOX/ARCHIVE/SPAM/TRASH, found nowhere".
    const lostSnoozes: string[] = [];
    if (unrecovered.length) {
      let searched: Record<string, string[]> | null = null;
      try {
        searched = this.driver.getThreadFolders
          ? await this.driver.getThreadFolders(unrecovered)
          : null;
      } catch (error) {
        searched = null;
        console.error(
          `[MailEngine:${this.connectionId}] forceReSync: member search failed for ${unrecovered.length} unrecovered snooze(s) (${(error as Error).message}) — keeping all wake rows on ambiguous evidence`,
        );
      }
      for (const threadId of unrecovered) {
        const folders = searched?.[threadId];
        if (folders === undefined) {
          // No instrument or search failure: ambiguous — keep, loudly.
          console.error(
            `[MailEngine:${this.connectionId}] forceReSync: snooze ${threadId} not re-indexed and absence UNPROVEN — wake row kept; next sync converges`,
          );
        } else if (folders.length === 0) {
          lostSnoozes.push(threadId); // searched everywhere, positively gone
        } else {
          // The message EXISTS (the rebuild listing just missed it):
          // rescue — index the thread and restore its snoozed state.
          const synced = await this.syncThread({ threadId });
          if (synced.success) {
            await this.applyIndexLabelsFromSync(threadId, ['SNOOZED'], []);
            console.warn(
              `[MailEngine:${this.connectionId}] forceReSync: snooze ${threadId} missed by the ${folders.join('/')} listing window — rescued by member search`,
            );
          } else {
            console.error(
              `[MailEngine:${this.connectionId}] forceReSync: snooze ${threadId} exists on the server (${folders.join('/')}) but index catch-up failed (${synced.reason}); wake row kept, next sync converges`,
            );
          }
        }
      }
    }
    if (lostSnoozes.length) {
      await snoozeStore.delete(this.connectionId, lostSnoozes);
      console.error(
        `[MailEngine:${this.connectionId}] forceReSync: ${lostSnoozes.length} snoozed thread(s) POSITIVELY absent from the server (member search); pruned their wake rows (ids: ${lostSnoozes.join(', ')})`,
      );
    }
    // Orphan inventory (detect + surface ONLY — nothing is auto-deleted):
    // wake rows and notes keyed by thread ids the index no longer resolves.
    // This is the moment orphans would be minted, so report here, loudly.
    try {
      const orphanWakes = await findOrphanSnoozeThreadIds(this.connectionId);
      if (orphanWakes.length) {
        console.error(
          `[MailEngine:${this.connectionId}] forceReSync: ${orphanWakes.length} wake row(s) reference threads missing from the index (kept, NOT deleted): ${orphanWakes.join(', ')}`,
        );
      }
      const orphanNotes = await findOrphanNoteThreadIds(this.connection.userId);
      if (orphanNotes.length) {
        console.error(
          `[MailEngine:${this.connectionId}] forceReSync: ${orphanNotes.length} note(s) reference threads missing from every connection index of user ${this.connection.userId} (kept, NOT deleted): ${orphanNotes.join(', ')}`,
        );
      }
    } catch (error) {
      console.error(
        `[MailEngine:${this.connectionId}] forceReSync: orphan inventory failed:`,
        (error as Error).message,
      );
    }
    // Record the cursor this resync was built against (Phase 6.3). Leaving
    // folder_sync_state empty until the next JOB sync both forfeits the 6.2
    // ladder right after every forceSync AND races concurrent job syncs'
    // cursor writes — observed live: listThreads' empty-inbox async
    // forceReSync deleted the validity row a watcher-triggered job sync had
    // just recorded, so a read in between saw no cursor at all.
    await this.recordFullSyncCursor('inbox', preState);
  }

  /**
   * Persist the cursor + UID ledger for a folder that a full sync pass just
   * covered — the same completion bookkeeping syncFolderJob does, for the
   * api-process full-resync path. `preState` (folder state probed BEFORE
   * the listing) takes precedence so mid-sync arrivals stay ABOVE the
   * recorded cursor; snapshot failure degrades to cursor-from-preState —
   * the next sync just runs full.
   */
  private async recordFullSyncCursor(
    folder: string,
    preState: Awaited<ReturnType<NonNullable<MailManager['getFolderState']>>> | null,
  ): Promise<void> {
    const snapshot = await this.driver
      .fetchFolderDelta?.(folder, null, maxSyncCount())
      .catch(() => null);
    if (snapshot) {
      await replaceFolderLedger(this.connectionId, folder, snapshot.messages);
    }
    await upsertFolderSyncState(this.connectionId, folder, {
      uidValidity: preState?.uidValidity ?? snapshot?.newCursor.uidValidity ?? null,
      uidNext: preState?.uidNext ?? snapshot?.newCursor.uidNext ?? null,
      highestModseq: preState?.highestModseq ?? snapshot?.newCursor.highestModseq ?? null,
      pageToken: null,
      lastSyncedAt: new Date(),
      resyncCount: 0,
      syncMode: 'full',
    });
  }

  async isSyncing(): Promise<boolean> {
    return false;
  }

  // -------------------------------------------------------------------------
  // Misc (parity surface)
  // -------------------------------------------------------------------------

  async unsnoozeThreadsHandler(payload: { connectionId: string; threadIds: string[] }) {
    const { threadIds } = payload;
    if (threadIds.length) {
      await this.modifyLabels(threadIds, ['INBOX'], ['SNOOZED']);
      await snoozeStore.delete(this.connectionId, threadIds);
    }
  }

  async suggestRecipients(query = '', limit = 10) {
    const lower = query.toLowerCase();
    const rows = await getRecentSenders(this.connectionId, 100);

    const map = new Map<string, { email: string; name?: string | null; freq: number; last: number }>();
    for (const row of rows) {
      const sender = row.latestSender;
      if (!sender?.email) continue;
      const key = sender.email.toLowerCase();
      const lastTs = row.latestReceivedOn ? new Date(row.latestReceivedOn).getTime() : 0;
      const entry = map.get(key);
      if (!entry) {
        map.set(key, { email: sender.email, name: sender.name || null, freq: 1, last: lastTs });
      } else {
        entry.freq += 1;
        if (lastTs > entry.last) entry.last = lastTs;
      }
    }

    let contacts = Array.from(map.values());
    if (lower) {
      contacts = contacts.filter(
        (c) => c.email.toLowerCase().includes(lower) || c.name?.toLowerCase().includes(lower),
      );
    }
    contacts.sort((a, b) => b.freq - a.freq || b.last - a.last);

    return contacts.slice(0, limit).map((c) => ({
      email: c.email,
      name: c.name,
      displayText: c.name ? `${c.name} <${c.email}>` : c.email,
    }));
  }

  async inboxRag(query: string): Promise<{ result: string; data: unknown[] }> {
    if (!env.AUTORAG_ID) {
      return { result: 'Not enabled', data: [] };
    }
    // AutoRAG was a Cloudflare-only product; with AUTORAG_ID unset in the
    // self-hosted config this path is unreachable. Kept as a guard.
    console.warn(`[MailEngine] inboxRag requested for "${query}" but AutoRAG is not available`);
    return { result: 'Not enabled', data: [] };
  }

  async searchThreads(params: {
    query: string;
    folder?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string;
  }) {
    const { query, folder = 'inbox', maxResults = 50, labelIds = [], pageToken } = params;
    try {
      const r = await this.driver.list({ folder, query, labelIds, maxResults, pageToken });
      return {
        threadIds: r.threads.map((t) => t.id),
        source: 'raw' as const,
        nextPageToken: pageToken,
      };
    } catch (error) {
      console.error('[MailEngine] searchThreads failed:', error);
      return { threadIds: [], source: 'raw' as const, nextPageToken: pageToken };
    }
  }

  /**
   * Plain folder listing for the chat's listEmails tool: newest threads with
   * sender/subject/date, no search query. Same driver.list path the UI-facing
   * probes use — a query-less list of a folder that holds mail always returns
   * threads, unlike a literal-text search that happens to match nothing.
   */
  async listFolderSummaries(params: { folder?: string; maxResults?: number }) {
    const { folder = 'inbox', maxResults = 20 } = params;
    const capped = Math.min(Math.max(1, Math.floor(maxResults)), 50);
    const r = await this.driver.list({ folder, query: '', labelIds: [], maxResults: capped });
    return {
      folder,
      count: r.threads.length,
      threads: r.threads.map((t) => {
        const raw = (t as { $raw?: Record<string, unknown> }).$raw ?? {};
        return {
          threadId: t.id,
          sender: (raw.from as string | undefined) ?? null,
          subject: (raw.subject as string | undefined) ?? null,
          date: (raw.date as string | undefined) ?? null,
          unread: (raw.unread as boolean | undefined) ?? null,
          messageCount: (raw.messageCount as number | undefined) ?? null,
        };
      }),
    };
  }

  /**
   * AI topic suggestions, cached in Redis (Phase 3.4: replaces the DO
   * ctx.storage cache). Generation is guarded by SET NX so two processes
   * don't regenerate at once; a lost lock just means this caller returns []
   * and the winner fills the cache — stale regeneration is benign.
   */
  async getUserTopics(): Promise<UserTopic[]> {
    const cacheKey = `topics:${this.connectionId}`;
    const cached = await redis().get(cacheKey);
    if (cached) {
      try {
        return (typeof cached === 'string' ? JSON.parse(cached) : cached) as UserTopic[];
      } catch {
        // fall through to regeneration on a corrupt cache entry
      }
    }

    const lock = await redis().set(`topics:lock:${this.connectionId}`, '1', {
      nx: true,
      ex: 120,
    });
    if (lock !== 'OK') return [];

    try {
      const subjects = await getAllSubjects(this.connectionId);
      const topics = await generateWhatUserCaresAbout(subjects.slice(-200));
      await redis().set(cacheKey, JSON.stringify(topics), { ex: 24 * 60 * 60 });
      this.broadcast({ type: OutgoingMessageType.User_Topics });
      return topics;
    } catch (error) {
      console.error(`[MailEngine:${this.connectionId}] topic generation failed:`, error);
      return [];
    } finally {
      await redis()
        .del(`topics:lock:${this.connectionId}`)
        .catch(() => undefined);
    }
  }

  /** Approximate index size in bytes from Postgres (Do_State storageSize). */
  async getDatabaseSize(): Promise<number> {
    return await getIndexSizeBytes(this.connectionId);
  }
}

const engineCache = new Map<string, Promise<MailEngine>>();

/**
 * Memoized per-process engine lookup (replaces DO idFromName + dormroom
 * shard addressing). The promise is cached so concurrent first calls share
 * one init — the plain-class equivalent of blockConcurrencyWhile.
 */
export const getMailEngine = (connectionId: string): Promise<MailEngine> => {
  let promise = engineCache.get(connectionId);
  if (!promise) {
    promise = MailEngine.init(connectionId).catch((error) => {
      engineCache.delete(connectionId);
      throw error;
    });
    engineCache.set(connectionId, promise);
  }
  return promise;
};

/** Drop a cached engine (e.g. after connection credentials change). */
export const evictMailEngine = (connectionId: string) => {
  engineCache.delete(connectionId);
};
