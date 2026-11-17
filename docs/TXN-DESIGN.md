# TXN: one durable transaction layer for items, billing and refunds (design)

This is design only. Branch `slice/TXN` off origin/main 02b43fc1 (v0.75.0). Strict, $0. No runtime code changes here.

- **Status:** design for agreement. Nothing is migrated.
- **Rules it serves:** GATES rule 17 (persist before mutate) and rule 18 (crash points and conservation in every strict slice,
  failing first).
- **Line numbers** are main's (02b43fc1) unless a branch is named.

**Contents**

- §0 The crash model
- §1 The audit
- §2 Why the same P1 keeps coming back
- §3 The layer
- §4 The crash harness
- §5 The conservation check
- §6 Migration
- §7 How a slice follows rules 17 and 18
- §8 Noah's decisions
- §9 What the harness won't catch
- §10 Round 1 revision log
- §11 Round 2 revision log
- §12 Round 3 revision log (§12.1 round 4 edits)

---

## 0. The crash model: what "durable" has to mean

There are four ways an operation can be interrupted. Today's gates test only the first two.

| Model | What it is | What survives | How we test it today |
|---|---|---|---|
| **P** | Process crash: `Runtime.halt`, a JVM abort, an OOM kill | Everything the process handed to the OS, including renames that have not been fsynced | kill points (`dev.journal.killAt`), `+save` |
| **A** | An asynchronous save inside the operation. Vanilla's autosave (`saveAllChunks(false)`), the mod's periodic ledger save (10 s), a chunk unload or a logout can each persist *in-memory* state partway through a multi-tick operation | Whatever that save wrote, chunk by chunk | almost never; a few `+save` cases |
| **O** | OS crash or power loss | Only what was fsynced, plus renames whose **directory** was fsynced | not testable by halts; units with fault injection (PSV's `QueueWritePSVFixTest`) |
| **R** | A refused or failed write: SS's undurable chunk, an IOException, disk full, a `loadFailed` session | Whatever was written before the refusal | some units, plus `dev.queue.writes`, `dev.stockpile.ss` |

TXN's guarantee is **exactly once under P, A and R**, and under O wherever the stores it relies on are fsynced, which §3.1 makes
true. There is no at-most-once exception any more: since round 2 every drop or overflow is an owed collectible (§3.4 O).
A player's inventory is exactly once through a player attachment and an acknowledged save.

A `Runtime.halt` keeps the page cache, so **no kill-point run can show that a missing fsync is a bug** (§9). The O model is
covered only by source checks and fault-injected units.

---

## 1. The audit: every path that persists items, billing or refunds

### 1.1 The stores

| Store | File | Atomic unit | Forces (main) | Notes |
|---|---|---|---|---|
| Ledger | `architect/stockpiles.json` (`Stockpiles.save` 2913-2960) | the whole file (tmp + `ATOMIC_MOVE`) | **none**: no file force, no directory force. The IOException is caught and logged (2959); `unsaved` stays true | piles, stock, `credited` keys, pending credits, custody, provided, paid records, cell books. CXD adds `crateOwed`, DR2 adds `owedDrops` |
| Queue | `architect-queue.json` (`Placement` 525) | whole file | **none** on main. PSV forces the file and the directory and answers a generation | group removals: `decCredit`, `decStock`, plans, stalled list |
| Sites | `architect-sites.json` (`Sites` 2619) | whole file | file forced, directory **not** | site, group and infra records, pending records |
| World journal | `JournalStore` entries 899, index 1000 | per file, with the index as the commit | **none** (an NBT read-back, no force) | cell before/after, undo groups, status |
| Chunks | region files (vanilla IO worker) | one chunk | forced per flushed save; SS (`RegionDurability`) tracks it | blocks, block entities (crate ledgers, container contents, CXD's `CxdTaken`), chunk attachments (DR2 `MinedCells`) |
| Entities | `entities/` region files | one chunk's entities | forced on a flushed save | item entities, saved **separately** from their chunk |
| Players | `playerdata/<uuid>.dat` | one file | vanilla | inventories |
| Regions | `RegionStore` 71-75 | file | file forced, directory not | region records, revisions |

Eight stores and four durability rules (on main). No operation that moves items touches only one of them.

### 1.2 The "confirmed save" primitives, which all mean different things

| Primitive | Where | What it guarantees |
|---|---|---|
| `Stockpiles.saveWithWorld` | main 2755 | players, chunks flushed, SS undurable check, then `save()`. The quiet (periodic) path **returns silently** when refused (2799). `save()` swallows an IOException |
| `Stockpiles.saveLedgerFirst` | main 2865 | the ledger, then players and chunks. No SS check, so the ledger can be published over undurable chunks |
| `Stockpiles.saveCredit` / `saveCreditPending` | main 1348/1365 | `saveWithWorld`. The pending variant **swallows** the refusal |
| `Stockpiles.saveConfirmed` | OVF, CXD | runs `saveWithWorld` if `unsaved`, then throws if still `unsaved`. **Not a durability guarantee**: no force, and an IOException in `save()` leaves `unsaved` true by accident, not by design |
| `Stockpiles.saveWithWorldConfirmed` | LC3 round 4 1391 | forces the ledger's temp file. No directory force. Abandon path only |
| `Stockpiles.durableBarrier` | DR2 2863 | flushed world save known durable, then the ledger. Repair only |
| `Placement.save` → generation, `written(gen)`, `writeSave` + `forceDir` | PSV 464/612/693/537 | **the only real durable write**: file forced, renamed, directory forced, then the generation counts |
| `Placement.saved()` (the saver's turn) | main | a queued save treated as done: the PSV bug. Removed by PSV |

### 1.3 The paths

The "Crash windows" column uses these abbreviations:
- **W:** a P/A/O window that dupes or loses items;
- **R:** a refusal window;
- **—:** none known.

"Branch" is the in-flight branch that changes the path. Ordering abbreviations:
- **sWW:** `saveWithWorld`;
- **LF:** `saveLedgerFirst`.

| # | Path | file:line (main) | Persists today (order; sync or queued; confirmed?) | Crash windows | Branch |
|---|---|---|---|---|---|
| 1 | Single-site removal (deconstruct) | `Sites.removeDetailed` 1538. Custody 1608, `prepareDeconstruct` → `Builder` 2678 (crate `takeStock` 2777), `holdPendingCredits` 1381, sWW 1633, K5 1658, journal undo commit, K6 1664, records pending, writes, `dropDeconstruction` 2865 → `creditRefund` 2888 → `saveCreditPending` 2867 | custody, pending credits: sWW (not forced). Journal undo: index rename (not forced). Credit: sWW, refusal swallowed. Crate stock taken **in memory before any save** | **W**: crate stock taken before a record (CXD). **W**: OVF CS1, overflow entities before the ledger. **R**: credit refused and the record then dropped (J2: books at start). **O**: nothing forced | CXD, OVF, PSV (P1-2 refusal), LC3 |
| 2 | Group / stage removal, R1 plan | `Groups.plan` 829-1080: custody 1018, sWW 1033, FKC1, `prepareDeconstruct` per member, `decCredit` 1044/1052/1073, `decStock` | custody: sWW. Credits and crate stock in the **queue file**, a second store. Queue save `Placement.save` (queued; main's barrier = the saver's turn) | **W**: crate stock taken at R1 and held only in memory and the queue (PSV P1-3, CXD). **W**: a queue write failing while R2 commits (PSV). **W**: custody stranded on abandon (LC3) | PSV, LC3, CXD, DR2 |
| 3 | Group member credit | `Groups.credit` 234-258 → `creditRefund`, `saveCredit` 257 | after the restore. sWW, then the member leaves the queue | **W**: FKC2 (custody credit after the restore). OVF CS1 overflow | OVF, DR2 |
| 4 | Group end / unwind | `Groups.end` 1257-1307, `writeBack` 1265 | custody back (memory), queue save | **W**: custody back in memory, not saved before records drop (LC3 round 4 P1) | LC3, PSV |
| 5 | Pre-save before commit | `Groups.preSaved` 1110-1116; `RestoreJob.groupSaved` | the barrier = the saver's turn, not the write | **W**: an R2 commit with no durable queue (PSV) | PSV |
| 6 | Standalone road restore | `RestoreJob.stepInfra` 407, `creditRefund` 497, `saveCredit` 504 | credit, then sWW | OVF CS1 | OVF |
| 7 | Road crate on removal | `RoadBuilder.beforeRemove` 600-642 (`takeStock` 642) | crate stock taken into a Credit in memory | **W**: taken before any record (CXD leftover) | CXD (out of scope) |
| 8 | Construction complete leftovers | `Builder.complete` 2123-2153 (`takeStock` 2139); `RoadBuilder.complete` 495-508 | taken and dropped in one tick, the chunk saved later | **W** (P/A): the drop entities and the emptied crate in different storages (entity vs chunk) | CXD (leftover) |
| 9 | Orphan crate right-click | `Builder.openCrate` 2326-2346 | takes and drops in one tick | **W**: as row 8 | — |
| 10 | Construction delta refund | `Builder.applyConstructionDelta` 3316, `saveCredit` 3456; `SiteDeltas.applyChecked` D1-D8 | credit after the delta's writes. OVF holds it pending before D8 (OVD1) | **W**: CS1 lost the refund (OVF finding 1). A crash between OVD1 and D8 drops it unless the delta rolls forward | OVF |
| 11 | Put-down / XR take-ups | `RegionOverwrites.retakeOnce` 208-249 (`credit` 246, `saveCredit` 249); `retakeToPile` 259-265 (`giveBack`); `lotTakeUp` 316-339; `RoadBuilder.convert` 170 | keyed credit + sWW; `retakeToPile` unkeyed | OVF CS1 (keyed). **W** (unkeyed): `giveBack` overflow entities before the ledger | OVF |
| 12 | Keyed credit core | `Stockpiles.credit` 1181-1197 (`dropOverflow` 1197) | the ledger in memory, overflow entities **spawned first** | **W**: OVF's bug (overflow paid twice across CS1) | OVF, DR2 (conflicting fixes) |
| 13 | Region fluids charge | `RegionFluids.gate` 669/788 → `Stockpiles.charge` 1249-1275 (`chargeOnce` 1267, `dropOverflow` 1273, sWW 1275) | keyed chargeOnce, bucket overflow dropped, sWW (refusal throws) | **W**: overflow entities before the ledger. **W/R**: a refused save, then the caller records the charge (OVF finding 2) | OVF |
| 14 | Region scoop (lava back) | `RegionFluids.gateOne` 2128/2161 → `scoop` 1299-1311 | keyed credit, overflow dropped, sWW | as row 13 | OVF |
| 15 | Mechanism charge | `MechCharges.hold` 166/230 → `charge` | as row 13 | as row 13 | OVF |
| 16 | Mechanism refund | `MechCharges.refund` → `Groups.decCredit` 1052 | queue + credit | as rows 2/3 | PSV |
| 17 | Pending-credit settle at start | `Stockpiles.settlePendingCredits` 1412-1441 (called from `Fills.atStart` 974) | infers the removal's fate from the site state (`standingSite`, `pendingSite`). sWW, refusal logged | **inference**: a site re-placed with the same key, or a delta key (OVF `deltaFate`) | OVF |
| 18 | Fill (FK) | `Fills.step` 591-699: FILLING (setPhase), FK1, locks + `purse.pay` + container writes + `markFilled`, FK2, sWW 694, FILLED, FK4 | an intent in the sites record, then one sWW | **P** only. FK1 to FK4 run in one server-thread call, so no autosave interleaves (an A window here is not verified: there is no yield). Replay relies on FILLING; O-exposed | — |
| 19 | Custody take | `Fills.takeCustody` 804-860 | containers cleared + `holdCustody` in memory; the caller saves | hypothesis only: the take and the caller's sWW run in the same tick, with no yield found, so no A window is verified. Exposed under O and R (a refused save unwinds by `writeBack`, not idempotent on main) | LC3 |
| 20 | Custody write-back | `Fills.writeBack` 861; `Fills.atStart` 973-1015 | containers rewritten, the ledger released, saved later | **W**: not idempotent on main (LC3's `writeBackAbandoned` is) | LC3 |
| 21 | Stockpile create | `Stockpiles.create` 480-520 | sWW | — | — |
| 22 | Crate removal from a pile (forced) | `removeCrate` 614-652 | drops excess entities, then sWW | **W**: entities before the ledger (OVF leftover) | — |
| 23 | Dissolve | `dissolve` 686-720 | pending first (sWW 702), to the player via LF 718 (players after), ground drops + sWW 720 | **W** loss at LF1 (declared: loss never dupe). Ground drops before their ledger save (leftover) | — |
| 24 | Withdraw / Take | `withdraw` 851-880 | sWW if pending, then LF 880 | LF1 loss window (declared) | — |
| 25 | Insert / deposit into a pile | `Stockpiles.accept` 1149; `Builder.insertFromInventory` 2357, `insertItems` 2413 | the player's inventory shrinks, the ledger grows. Saved by periodic or logout (F9) sWW | **A**: player.dat saved after the deposit, the ledger not (autosave saves players first). **Loss** within one periodic window | — |
| 26 | Insert into a crate (screen, hopper, dev) | `Builder` 1037/1047 (crate ledger accept) | the crate BE ledger, the hopper's chunk, possibly different chunks | **A**: hopper and crate in different chunks, saved in different snapshots (dupe or loss of in-flight stacks). Vanilla's class | — |
| 27 | Feed (stock → cells) | `Stockpiles.feed` 1635-1783 (`giveBack` 1703/1716, `dropOverflow` 1698, sWW 1783); `purse.pay` | in memory per cell, periodic sWW (JR: the ledger never ahead of the chunks); RL reconciles at start | ledger behind world: RL's reconcile (a cell book) re-derives it. Bucket give-back overflow entities before the ledger | — (bulk stream, §3.9) |
| 28 | RL reconcile at start | `reconcileAtStart` 2527-2566; `reconcile` 2585-2659 (`dropOverflow` 2611/2621/2659) | give-backs + overflow entities, then sWW 2566 | **W**: re-done at the next start if its sWW never lands → double drop (OVF leftover) | OVF (leftover) |
| 29 | Adopt crates into a pile | `Stockpiles.adopt` 899-1002 (SAC1 965, sWW 966, SAC2 975, sWW 1002); `repairJoinedCrates` 1014-1060 | ledger + restored crate cells (sWW), then records | **W**: an unread or unloaded crate restored and released with its stock (ADP) | ADP |
| 30 | Crate extraction (CXD) | CXD: `CrateOwed` capture / commit / settle / `atStart` | the `crateOwed` record in stockpiles.json, `saveConfirmed`; `CxdTaken` marker in the crate BE; settle drops entities with LF | LF1 loss window at settle (declared). `saveConfirmed` not forced (O) | CXD |
| 31 | Repair (DR) | DR2: `Repairs.run` → `durableBarrier`, record phases written / settling / final | cells, barrier, then settle | overflow: DR2's `owedDrops` conflicts with OVF | DR2 |
| 32 | Overflow owed drops | DR2: `StockLedger.oweDrop`, `OverflowDrops.spawnOwed` | owed in the ledger, spawned after its save, tagged; the start resolves by tag on entity load | **W**: a player picks up a tagged drop, the entity chunk is saved, a crash before the clear, then a respawn (absent read as never spawned) | DR2 (superseded by OVF (c)) |
| 33 | Abandon a stalled removal | LC3 `Groups.abandonSteps`, AB1-AB4 | custody back → `saveWithWorldConfirmed` → journal release → `dropPending` → queue save | fixed in round 4. Still not dir-fsynced | LC3 |
| 34 | Region revision drain / undo | `Revisions` RVU1-RVU3, RVC1-RVC2 (1495-1760) | manifest + region.json, then drain through Groups | inherits rows 2-5 | PSV |
| 35 | Staged terrain BUILT | ST/HB: `RegionTargets` (HB 1444 `saveAllChunks` before BUILT); `Stockpiles.reconcileTerrain` 2679 | chunks flushed before the queue marks BUILT | no items (FREE). The reopen of a BUILT target with holes re-fills XR cuts unless shadowed (HB unit only) | ST, HB |
| 36 | Region adopt / unadopt | `RegionAdopt` AD1-AD4, UA1-UA4 | journal + records; no items move | — (records only) | — |
| 37 | Adopted-site delta removal | `Adopt` 1290-1305: `prepareDeconstruct` (crate take), journal undo commit, `markPending`, `writeNow` | no pre-commit save of the deconstruct at all | **W**: the crate stock taken and the commit made with no durable record (added after the GPT review) | — |
| 38 | Construction delta OVERWRITE drops | `Builder` 3338-3346: the player's replaced blocks dropped as items **before** `SiteDeltas.applyChecked` commits | entities, then the delta's commit | **W**: a crash after the entity save, before D8: the delta is retried and drops again (added after the GPT review) | OVF (the same function) |

**Headline:** 38 paths. 33 move items or billing (rows 21, 34, 35 and 36 move none, and row 5 is a guard). **31** of the 33 have
a known P, A or R crash window on main or on their branch. Rows 18 and 19's A windows were hypotheses and are withdrawn; their
P/O/R exposure stays. Two of them (rows 24 and 30) are the declared LF1 window: a loss,
never a dupe. Row 27's window is closed by RL's reconcile, except for its bucket overflow. On **main**, every row is exposed under the O model: neither `Stockpiles.save` nor `JournalStore` forces anything. LC3 round 4
forces the ledger's temporary file on its abandon path only (branch line 2968), and that is not on main. Eight in-flight branches fix about 20 of them, each with its own primitive.

---

## 2. Why the same P1 keeps coming back

1. **"Confirmed" has five meanings** (§1.2). A slice picks one, and the reviewer finds the case it doesn't cover.
2. **Intent is spread over stores, so recovery infers it.** Each feature reads the state of several stores and decides what must
   have happened. Today there are six such tables:
   - `settlePendingCredits`'s site-state table;
   - OVF's `deltaFate`;
   - CXD's 2x3 `resolve`;
   - ADP's `crateFate`;
   - DR2's tag `Resolution`;
   - LC3's abandon prefix rules.

   Every new state is a new row, and every missed row is a P1.
3. **The amounts live in two places.** Group credits and crate stock live in the queue (`decCredit`, `decStock`) and are booked in
   the ledger. A two-file commit with no atomicity is the PSV/LC3 class.
4. **Some outcomes can't be observed.** Item entities sit in a separate storage, can be picked up and despawn. A player's
   inventory can't be read back at start. Each slice rediscovers this (OVF, DR2, CXD's LF1).
5. **Recovery order is listener registration order.** At least eight SERVER_STARTED listeners plus the first tick
   (`Builder` 142-149, `Fills.atStart`, `CrateOwed.atStart`, ...). A new resolver has to find its slot by hand.
6. **The asynchronous save (model A) is invisible to the gates.** In-memory state persists whenever vanilla or the periodic save
   decides. "Mutate, then save" is unsafe even with no crash inside the save.

---

## 3. The layer

### 3.1 Step 0: the durable primitives (T0, being built on `slice/T0`)

*(Rewritten in round 2. It follows T0's brief: `DurableFile` with a directory force, persisted generations, a players → chunks →
ledger barrier, and IN_DOUBT. Check it against T0's as-built when that lands.)*

```java
final class DurableFile {                       // PSV's writer, lifted out of Placement
  enum Outcome { OK, REFUSED, IN_DOUBT }          // T0's names (origin/slice/T0 042da098)
  long request();                               // the next generation (no IO)
  Outcome write(JsonObject body, long gen);     // body + {"store": id, "gen": gen}; tmp, force(true), ATOMIC_MOVE, force(dir)
  boolean written(long gen);                    // writtenGen >= gen, OK only
  long writtenGen();                            // persisted: read back from the file at load, so it survives restarts
  boolean inDoubt();                            // a rename happened but its directory force did not return
}
```

- **Persisted generations** *(round 2, P1-3)*.
  - Every `DurableFile` writes its `store` id (a UUID minted when the file is first created, kept across rewrites) and its `gen`
    inside the file.
  - **At load, a generation is not proof of durability** *(round 3, P1-1)*. A process restart keeps the page cache, so a file
    installed IN_DOUBT before the restart loads looking fine, and a later power loss can still lose it. So:
    1. load **re-forces** the installed file and its directory (and the directory's parent if this session created it);
    2. only when both forces return does `writtenGen` become the file's `gen`;
    3. until then the store is `IN_DOUBT` from load: its generation acknowledges nothing, no await or decision it carries is
       satisfied, and the store retries the forces every tick.

    T0's fix round is implementing this in `DurableFile` (its initial commit 042da098 set `written` from `readGen` directly). This
    paragraph follows T0's brief, and gets checked against origin/slice/T0 when it moves.
  - `request()` continues from the loaded `gen`.
  - So an await persisted in `txn.json` (`{"store": "<id>", "gen": 88}`) is meaningful after a restart: it is satisfied when the
    loaded file has the same `store` and a `gen` of at least 88.
  - A file with a different `store` id (replaced or restored from a backup) satisfies nothing. The txn holds.
- **IN_DOUBT** *(round 2, P1-5)*. Each failure is classified:
  - a failure before the rename is `REFUSED`: nothing was installed;
  - a failure after the rename (the directory force throws) is `IN_DOUBT`: the new content may or may not survive an OS crash. In
    memory the store **keeps the new version as installed**, never reverting to the old one;
  - the store retries the directory force (and then the whole write) every tick until it returns `OK`;
  - a txn step whose write is `IN_DOUBT` is **held**, never compensated: a decision that is IN_DOUBT counts as UNKNOWN (§3.6);
  - T0 removes `JournalStore.fail`'s revert of its in-memory head (main 968) for a post-rename failure. That revert is exactly the
    "a failed acknowledgement means not committed" mistake.
- **Applied to:**
  - `txn.json`;
  - the ledger;
  - the queue (PSV);
  - sites;
  - `RegionStore`;
  - the world journal's index and entry files. Noah accepts batching their forces per tick if T0's measured cost is reasonable
    (decision 5).

  A newly created directory has its parent forced once.
- **The barrier is global, not per txn** *(round 2, P1-1)*. `Stockpiles.barrier()` publishes the whole ledger, so its dependencies
  are **every** source the ledger's in-memory state depends on, including the bulk ingress (a hopper's source chunk, a player's
  deposit). It is built on **save epochs**:
  - A mixin on the chunk storage's `IOWorker.store` future (confirmed usable in 26.3 by the GPT pass) records each chunk and entity
    write's outcome, with its epoch. A mixin at `ChunkMap`'s serialization records a serialization failure as a failed write of that
    chunk.
  - A barrier closes epoch *e*:
    1. it saves every player and **acknowledges each save** (below);
    2. it runs a flushed `saveAllChunks`;
    3. it waits for **every** write future of epochs up to and including *e*;
    4. it requires each to have succeeded, `RegionDurability.undurable` to be empty, and every pending directory force (below) to
       have returned;
    5. only then does it write the ledger, with `"epoch": e` inside it.
  - Any failed or missing acknowledgement in the epoch, from **any** chunk or player, makes the barrier `NotDurable`, and the
    ledger is not published. The failed chunk or player stays **owed** (as `RegionDurability.OWED`) until a later epoch rewrites it
    with success. Until then no barrier succeeds, so no unrelated credit can be published over it.
  - A participating `.mcc` external chunk is NotDurable (vanilla never forces it). `/save-off` (`noSave`) refuses (DR2's
    `savingOff`).
  - The bulk streams' periodic save (the 10 s `saveWithWorld`) becomes a barrier too, so JR's rule ("the ledger never ahead of the
    world") is enforced by acknowledgement, not assumed.
- **Player saves are acknowledged positively** *(round 2, P1-2; round 3, finding 3 on T0)*.
  - Vanilla's `PlayerDataStorage.save` catches its own IOException.
  - `Util.safeReplaceFile` **discards** the boolean of `safeReplaceOrMoveFile`, so a failed replace restores the old `.dat` without
    throwing.
  - Watching the warning call is therefore not enough, and neither is forcing whichever `.dat` exists. Instead:
    1. a mixin captures the serialized `CompoundTag` bytes the save meant to write, and the **actual result** of
       `safeReplaceOrMoveFile`;
    2. the acknowledgement is positive only when that result is true, the installed `.dat` (read back) hashes to the intended
       bytes, and the file and `playerdata/` forces returned;
    3. anything else is a failed save: that player is owed.
- **Failure debt is retried, not only recorded** *(round 3, P2-5)*.
  - **A chunk** whose serialization or write failed: `ChunkMap.save` marks it saved (`tryMarkSaved`) before serializing, so
    recording the failure alone would never rewrite it, and every later barrier would refuse for ever. The mixin instead:
    1. **restores its dirty state** (when serialization failed) or **keeps the failed snapshot** and requeues it to the IO worker
       (when the write failed);
    2. **pins the chunk** so it isn't unloaded with its only copy in memory. *(Round 4, review 4's implementation constraint.)* Native
       chunk unload goes on after `ChunkMap.save` returns, so a ticket added afterwards is too late: the retention must intercept the
       **unload boundary itself** (the holder's drop from the visible map, where the save's result is known), not add a ticket after
       the save;
    3. retries at every barrier until an acknowledgement clears the debt and the ticket.
  - **An online player** whose save failed is saved again at the next barrier.
  - **An offline player** (a failed logout save; `PlayerList.saveAll` visits only online players) keeps its captured snapshot in a
    debt table. The table rewrites that exact snapshot at each barrier until it is acknowledged. If the player logs in first, the
    snapshot is replaced by the live player, whose save is then required.
  - IO debt is separate from the UNKNOWN-hold policy (decision 4). It is recoverable, so it is retried.
- **Native directory entries** *(round 2, P1-6)*:
  - a mixin on `RegionFileStorage`'s region-file creation forces the region directory after a new `.mca` is created, and marks it
    owed until that force returns;
  - `PlayerDataStorage`'s replace forces `playerdata/` after the replace.

  A barrier waits for both. On Windows a directory can't be opened for a force: best effort, logged once, and the O guarantee is
  narrowed there.
- **Best effort is only the named platform limit** *(round 3, finding 4 on T0)*. Only the documented Windows case (opening a
  directory as a channel is unsupported) is best effort. On macOS and Linux, **any** failure to open or force the directory after a
  rename is `IN_DOUBT`, never OK: a directory that allows the rename but denies read access included.
- **One barrier replaces four primitives:** `saveConfirmed`, `saveWithWorldConfirmed`, `durableBarrier` and the quiet path's
  silent return. It returns `Barrier{epoch, ledgerGen}` or throws `NotDurable`.
- **What the O guarantee covers:** writes the barrier acknowledged, with their directory entries forced, on macOS and Linux.
- **The legacy payout order stays until T7** *(round 2, P2-7)*. `withdraw` and dissolve-to-player keep `saveLedgerFirst` (the
  ledger, then players, then chunks): with no player marker yet, a player-first save at TXB1 would dupe. They move to the barrier
  only in T7, with the player attachment.

### 3.2 Where the journal lives: its own small file, `architect/txn.json`

The intents live in **their own file**, written whole through `DurableFile`. They are not in the ledger file. *(Revised after the
GPT review, P1-1.)*

**Why not the ledger file** (the first draft's choice):
- A write of `stockpiles.json` publishes **every** pile's in-memory state. That includes bulk state JR says may only be published
  over durable chunks: a hopper's deposit into pile A, whose hopper chunk still holds the items.
- So an intent written for pile B could persist A's credit ahead of the hopper's debit, which is a dupe that RL can't reconcile.
- Keeping the ledger's publication rule (players, then durable chunks, then the ledger: JR/HF) means the ledger is written only
  through `barrier()`, and an intent must not depend on it.

**Why not an append log:**
- per-record framing, CRC and a torn-tail rule;
- compaction.

The file stays small, because only open txns and the last done ids are kept. A whole-file atomic rewrite is simpler, and it is
the same primitive as the queue.

**Consequences:**
- **Ledger effects (L)** are idempotent by their key in the pile's `credited` set (the existing rule). They are published only by
  `barrier()`.
- **The intent and its ledger booking are in two files.** That is safe because an L effect's probe reads the key, and a txn
  retires only after the ledger generation holding its last L effect is confirmed (§3.7).
- **Corruption:** an unreadable `txn.json` is a `loadFailed` for txns. Every item op is refused up front (as PS F6 and PSV
  P1-2), and no feature resolver runs over the affected resources.
- **Size:** open txns only. A group removal of 50 members with their plans is about 50 KB. Measured writes of a 4-6 KB ledger are
  p50 0.3 ms unforced (818 `SS save:` lines); a force adds about 3-8 ms (measured in T0).

### 3.3 The entry schema (format 1)

```json
{
  "format": 1,
  "next": 1042,
  "open": [
    {
      "id": "tx-1041", "kind": "removal.site", "kv": 1, "key": "site:s12@99", "decision": null, "phase": "PREPARED",
      "at": {"tick": 123456, "wall": 1731800000000}, "who": "architect:steward | <uuid> | null",
      "resources": ["site:s12", "crate:minecraft:overworld@10,64,-3", "box:minecraft:overworld@..", "pile:steward:town"],
      "decider": {"kind": "journal", "undoGroup": "tx-1041"},
      "payloads": {"site_removed": {"site": {"id": "s12", "..": ".."}}, "batch_done": null},
      "effects": [
        {"i": 0, "op": "crate.take",    "class": "B", "dim": "minecraft:overworld", "pos": [10,64,-3], "items": {"minecraft:oak_planks": 12},
         "from": "crate", "to": "transit"},
        {"i": 1, "op": "custody.take",  "class": "B", "pos": [[11,64,-3]], "items": {}, "from": "container", "to": "transit"},
        {"i": 2, "op": "journal.undo",  "class": "D", "entries": [".."], "undoGroup": "tx-1041"},
        {"i": 3, "op": "world.restore", "class": "W", "entries": [".."], "chunks": [[0,-1]]},
        {"i": 4, "op": "ledger.credit", "class": "L", "pile": "steward:town", "key": "site:s12@99", "items": {}, "from": "transit", "to": "stock"},
        {"i": 5, "op": "record.drop",   "class": "R", "store": "sites", "site": "s12"}
      ],
      "receipts": {"0": {"gen": "chunk"}, "3": {"chunks": {"0,-1": "done"}}},
      "events": {"emitted": []}
    }
  ],
  "retiring": [{"id": "tx-1039", "await": [{"store": "q-3f2a", "gen": 88}, {"store": "s-91c0", "gen": 412}, {"epoch": 977}]}],
  "done": [{"id": "tx-1038", "key": "site:s11@97", "decision": "commit", "result": {"removed": true, "refund": {"minecraft:oak_planks": 3}},
            "payloads": {}}]
}
```

- **`id`:** `tx-<n>`, where `next` is persisted. The id is the **attempt key**: every begin mints a new one (§3.7, round 4). Each effect's idempotency key is `tx-1041/3`. The existing semantic keys
  (`site:<id>@<placedAt>`, `adopt:...`, `delta:...`, `crate:...`) stay on L effects as `key`. The `credited` set dedupes them, so a
  re-begun operation can't pay twice.
- **`kind` + `kv`:** the kind's schema version. An unknown kind, or a `kv` newer than this build's, is quarantined (§3.8).
- **`decision` and `phase` are separate fields** *(round 3, P1-2)*.
  - `decision` is **immutable once written**:
    - `null` (undecided);
    - `{"v": "commit"}`, written once, through `DurableFile` OK, or by the D effect's applied probe;
    - `{"v": "abort"}`;
    - `{"v": "abandon", "split": {...}}` (§3.6).
  - `phase` is **progress only**: `PREPARED`, `PREPARED_DONE` (§3.4), `EFFECTS_DONE` (§3.12: futures complete here), `ABORTING`,
    `RETIRING`. No phase value ever implies or erases a decision.
  - The recovery rule for every combination is the table in §3.6. A finished txn moves to `retiring` (§3.7), then to `done`: objects
    `{id, key, decision, result, payloads}`, kept within the result cache's bound (the last 4,096 results, about 1 MB; §3.7).
- **`decider`** *(round 4, P3)*: how the decision is made, not the decision. `{"kind": "txn"}` (the `decision` write in this file) or
  `{"kind": "journal", "undoGroup": ..}` (a D effect). It was a second `decision` member in round 3's example, which lost the undecided
  `null`.
- **`key`** *(round 4, P2)*: the semantic **dedupe key** (`site:<id>@<placedAt>`, `adopt:..`). It is not the attempt key (§3.7).
- **`payloads`** *(round 4, P2)*: the immutable event source data (the removed site's `SiteView` fields, the `BatchView`, the owner),
  captured in the intent itself, so it is durable before any destructive effect (§3.7).
- **`effects`:** the whole plan with every amount, written **before** any effect runs (R-1). The queue, sites and region records
  hold only the txn id (`"txn": "tx-1041"`), never amounts (R-7). `decCredit` and `decStock` go.
- **`receipts`:** hints only, saved when the file is next written. Recovery decides from the stores' own markers (§3.4) and from the
  phase, never from a hint.
- **`txn.format` and downgrades:** downgrading a world that holds transactions is **unsupported** (Noah's decision 3, dev mode;
  round 2, P2-8). The round-1 claim that a FORMAT bump makes older builds refuse was wrong: `Site.fileFromJson` (Site 506) and
  `Placement.load` (Placement 531) never check their outer version, and only `Stockpiles` (3027) does. T1 keeps one cheap partial
  net, and it is not a guarantee: `stockpiles.json` is written with FORMAT + 1 while a txn is open or retiring, so an older build at
  least refuses the ledger. The README and the release notes state "no downgrade across TXN".

### 3.4 Effects: classes by how recovery can observe them

*(Revised in round 1, and again in round 2: P1-2, P1-4, P2-9, Noah's decision 1.)*

| Class | Store | Marker / receipt (same atomic unit as the effect) | Probe | Guarantee |
|---|---|---|---|---|
| **L** ledger | `stockpiles.json` | the key in the pile's `credited` (or `applied`) set | read it | exactly once |
| **B** block entity / container | chunk | a receipt `tx-n/i` (and `tx-n/i!c` for its compensation) in a **chunk attachment** `architect_mc:txn_receipts` (a Fabric data attachment saved with the chunk, as DR2's `MinedCells`), written in the same change as the BE edit. The BE also gets the receipt in its own NBT, for CXD's insert refusal | the chunk attachment: APPLIED / COMPENSATED / ABSENT / UNKNOWN (chunk unreadable). It **survives the BE's replacement**: a later restore of the crate cell removes the BE, not the chunk's receipts | exactly once |
| **D** decision (journal) | world-journal index | `undoGroup = tx id` in the durable index commit | read the index | exactly once; IN_DOUBT counts as UNKNOWN |
| **W** world restore | chunks | the same chunk attachment receives `tx-n/i@restored` in the chunk's save after its last restored cell; the cells' own states are the evidence too | per chunk: DONE / PARTIAL / UNKNOWN | idempotent; the undo entries are kept until retirement |
| **R** record | queue / sites / region | an upsert carries `txn`. A drop leaves a tombstone `{store, gen}` in the txn entry, with the persisted generation (§3.1) | upsert: the record has `txn`. Drop: the record is absent and the loaded file's `store` and `gen` satisfy the tombstone | exactly once |
| **P** player inventory | `playerdata` | a player attachment `architect_mc:txn_receipts` saved in `player.dat` with the inventory, plus that player's **acknowledged save** (§3.1) | at the player's load: APPLIED / ABSENT. Offline: UNKNOWN for that effect only | exactly once. Retirement waits for an acknowledged save containing both the inventory and the receipt |
| **O** owed collectible | `stockpiles.json` | a keyed entry in the ledger's `owed` map: `{key, recipient (owner or player UUID), at (dim, pos), items}` | read it | exactly once. Collected later by a P effect |

- **Item entities are gone from the layer** *(Noah's decision 1: drops and full-inventory overflow stay collectible, with no
  uncertain loss)*. Each former drop becomes an **owed collectible** (O):
  - CXD's player-crate settle with no pile;
  - dissolve's ground drop;
  - the forced `removeCrate` excess;
  - `withdraw`'s and dissolve's full-inventory overflow (main 870);
  - row 38's OVERWRITE drops;
  - DR2's overflow (already gone under OVF (c)).

  The recipient collects owed items:
  - through the stockpile panel's Take;
  - by right-clicking the former crate's cell (Builder's `openCrate` path, now reading `owed` at that position);
  - with `/architect collect`.

  Each collection is a P txn and takes only what fits; the rest stays owed. There are no claims and no loss receipts. The exact
  UX (the panel line, the cell) is T7's contract.
- **Preparation boundary** *(round 2, P1-4)*. After a txn's prepare effects and their barrier, `txn.json` records `phase:
  PREPARED_DONE` (`DurableFile`, confirmed) before the decision. From then on recovery knows every prepare effect is applied: it
  does not probe them, and they can't go UNKNOWN because their evidence was overwritten. Before `PREPARED_DONE` the chunk
  receipts decide.
- **Same-chunk monotonicity** is used only over receipts in the chunk attachment, which nothing overwrites until retirement. Chunks
  and their entities are separate storages, and no probe crosses them.

### 3.5 The rules a txn kind must obey

- **R-1 Plan before persist.** Every amount is computed and nothing is mutated. The event payloads are captured here too (§3.7, round 4).
- **R-2 Persist before mutate (rule 17).** The intent is in `txn.json` (`DurableFile`, confirmed) before the first in-memory change
  of any store that a later save can persist: the ledger, BEs, containers, the queue, records or a player's inventory. A failed
  write touches nothing (`JOURNAL_UNAVAILABLE`).
- **R-3 A marker with every effect** (§3.4).
- **R-4 Chunk and ledger saves.**
  - (a) The ledger is published only by `barrier()`: players, then the chunks flushed and durable (§3.1), then the ledger. JR/HF's
    order is unchanged, for txns and the bulk streams alike.
  - (b) Inside a txn, a BE or P effect needs no ordering against the ledger: markers make every order recoverable.
  - (c) Each irreversible step outside the txn waits for a `barrier()` that covers every effect before it: the decision, an unseal,
    the end of a txn, and a W effect's chunk receipt.
  - (d) There is at most one barrier per step and per tick. A group removal's members share their tick's barrier.
- **R-5 No entities in a txn.** Every drop or overflow is an owed collectible (§3.4 O, Noah's decision 1).
- **R-6 One decision.** Before it, every applied effect is compensable; after it, every remaining effect is redo-able from the entry.
  The decision is the immutable `decision: commit` in `txn.json`, or a D effect (the journal undo group). **The decision is not completion:** a
  committed removal still owes its W restore, chunk by chunk, before any credit that depends on it. *(P1-2.)*
- **R-7 One copy of each amount.**
- **R-8 One recovery slot, and holds enforced by every writer** (§3.6). *(P1-3.)*

### 3.6 The API and the recovery algorithm

```java
Txn t = Txns.begin(Kind.REMOVAL_SITE, resources);    // refused: txn.json unavailable, or a resource held (SITE_BUSY)
t.plan(Effect.crateTake(level, pos, items)); t.plan(Effect.journalUndo(ids)); t.plan(Effect.worldRestore(ids));
t.plan(Effect.ledgerCredit(pile, key, items)); t.plan(Effect.recordDrop("sites", id));
t.persist();                 // R-2: txn.json durable; NotDurable -> nothing touched
t.step("take");    t.apply(0);                       // the BE change + its marker
t.barrier();                                         // R-4c before the decision
t.step("decide");  t.apply(1);                       // the journal undo commit, undoGroup = t.id(): the decision
t.step("restore"); t.apply(2);                       // per chunk, over ticks; each chunk receipted after a barrier covers it
t.step("credit");  t.apply(3); t.apply(4);           // only after every W chunk is DONE
t.retire();                                          // §3.7
```

- **Holds (P1-3).** An open txn's `resources` (sites, crates, boxes, piles, players) are a **guard every writer honours**, not only
  `begin`:
  - the feed skips a held site or pile entry;
  - crate and stockpile inserts (screen, hopper, dev) are refused at a held crate or box. This reuses LC3's `RemovalSeal` and FL's
    `FillHold` mixins, whose index takes held boxes as one more source;
  - menus already open over a held box close on the next tick;
  - legacy resolvers skip held resources.

  A hold is scoped to the txn's own resources. A held pile refuses only operations that would read the txn's transit amount; inserts
  and the feed for other targets go on.
- **Load is split from reconcile.** Today `Sites`' SERVER_STARTED listener reconciles inside load (`Sites` 189-205: adoption repair,
  `reconcile`, `SiteDeltas.atStart`; `SiteJournal.reactivate` 3176). T1 moves every reconcile behind the recovery slot, so the
  stores load first, then guards rebuild from `txn.json`, then txn recovery runs, then the legacy resolvers run, then ticking starts.

```
recover():
  for each open txn, oldest first:
    d = decision ?? (probe(D) == APPLIED ? commit (and write it) : probe(D) == UNKNOWN or IN_DOUBT ? hold : null)
    act by the table below; any UNKNOWN probe: keep held, retry when its chunk or player loads
  retiring: confirm the awaited generations (§3.7)
```

**Phase × decision × evidence: the recovery rule** *(round 3, P1-2)*

| decision | phase | evidence | recovery |
|---|---|---|---|
| null | PREPARED | receipts of prepare effects (some, none) | compensate each APPLIED prepare effect, newest first; write `decision: abort`; retire |
| null | PREPARED_DONE | prepare effects known applied; D probe ABSENT | compensate all prepare effects; `decision: abort`; retire. (A kind with a txn-file decision may also roll forward here only if its contract says so; the default is abort) |
| null | any | D probe APPLIED | write `decision: commit` (the external decision happened) and continue as the commit row |
| null | any | D probe UNKNOWN or IN_DOUBT | **hold**; never compensate |
| commit | PREPARED_DONE | W per chunk, L/R/P probes | redo every effect not APPLIED/DONE, in order; W before credits; then `EFFECTS_DONE`, events, retire |
| commit | EFFECTS_DONE | — | **still committed**: never compensate; fire any event not in `events.emitted`; retire |
| commit | RETIRING | awaits | confirm the awaits; drop the entry only when satisfied (§3.7) |
| abort | ABORTING | compensation receipts | finish compensation (idempotent `!c` receipts); retire |
| abandon | any | the recorded `split` | resume the **recorded** split: written members forward (as commit), unwritten members compensate. The split is never recomputed after it is written |
| any | any | an effect UNKNOWN | that effect's resources stay held; the rest of the row proceeds only where its order allows (W before credits) |

- **A non-journal kind** (a keyed charge, a deposit) has no D effect. Its decision is the `decision: commit` write, and
  `EFFECTS_DONE` without a decision can't occur: the decision is written before the first irreversible effect.

- **Exactly once:**
  - each effect probes its own store's marker (the chunk attachment for B and W, the player attachment for P), or is known applied by
    `PREPARED_DONE`;
  - a compensation leaves its own marker;
  - a second crash at any prefix of recovery replays from the same entry and the same markers.
- **Abandon after the decision** (T5; Noah's decision 2; round 2, P2-7). A decided removal never reverts by inference, but ops may
  **abandon** it. The abandon is a takeover of the **same** txn, not a second txn competing for its held resources:
  - `/architect removal abandon <group>` writes the immutable `decision: abandon` with the member split (`txn.json`, confirmed). It is allowed only over a `commit` decision, and it is the one decision that may follow another;
  - members whose W restore has any chunk receipt, or any cell no longer `after`, are **written**: they settle forward, credit
    included;
  - members with neither are **unwritten**: they compensate. Custody goes back (B, with receipts), their undo entries are released,
    and their pending records are dropped (R, tombstones);
  - the split is computed from evidence read after a barrier, and it is recorded before anything acts on it.

  LC3 will likely ship **without** abandon (Noah). Until T5, a txn removal refuses abandon (`SITE_BUSY`, "abandon arrives with
  T5"). LC3's legacy abandon, if it ships, applies only to legacy (non-txn) removals.
- **The ops command** `/architect txn resolve <id> commit|abort`, permission 2, logged:
  - `abort` is refused when the decision probe is APPLIED **or UNKNOWN**. An external commit always wins.
  - `commit` is refused while a PREPARED txn's own prepare effects are UNKNOWN.

### 3.7 Retirement and compaction

*(Revised in round 2: P1-3, P1-2.)*

A finished (or aborted) txn moves to `retiring` with **persisted** awaits (§3.1): `{store, gen}` for the ledger holding its last L
or O effect, the queue, sites and region records holding its last change and its tombstones, and `{epoch}` for the barrier that
covered its last chunk and player effects. An epoch is satisfied when the loaded ledger's `epoch` is at least it, because a ledger
publishes only after every chunk and player write of its epoch was acknowledged.

It leaves `retiring` only when every await is satisfied. A satisfied await stays satisfied across restarts; an unsatisfiable one (a
different `store` id) holds for ops. Until then:
- its undo entries are kept;
- its chunk and player receipts are kept;
- its holds stay on the resources whose evidence is still awaited.

After retirement, its receipts are stale. They are dropped the next time their chunk, BE or player is written, and never read
again.

**What compaction keeps** *(round 3, P2-3)*. A txn leaves `open` for `done`, but `done` is not just an id list. Each entry keeps:
- the **semantic key** (`site:s12@99`, `adopt:...`);
- the **terminal result** (`removed`, the `refund`, the blockers; the same fields a `RemoveResult` or a charge answer carries);
- every **pending event payload**, immutable, until `events.emitted` covers it in a `txn.json` write that is acknowledged OK.

**When payloads are captured** *(round 4, review 4 P2-3)*. Not at `EFFECTS_DONE`: `record.drop` is an earlier effect, and a crash after
the durable drop would leave a committed removal with a tombstone and no copy of the removed `SiteView` (`ApiEvents.removed` needs the
whole site). So:
- the event source data (the `SiteView` fields, the `BatchView`, the owner) is read during planning (R-1) and written in the intent's
  `payloads` by `persist()` (R-2). It is durable before the first effect, destructive or not, and never re-read from a store an effect
  may have changed;
- **the abort path:** an abort can owe `BATCH_DONE` (a batch the txn ended) without reaching `EFFECTS_DONE`. The `decision: abort`
  write carries the abort's own payload (the not-placed fields), in the same `txn.json` write, so the event fires at least once from
  the entry even after a crash mid-compensation. An abort never fires `SITE_REMOVED` or a stockpile change (§3.12.9);
- a payload is dropped only when `events.emitted` covers it in an acknowledged write.

Only then are the payloads dropped. The key and the result stay in the **result cache**: the last 4,096 results, bounded at about
1 MB.

**Attempt keys and dedupe keys** *(round 4, review 4 P2-4)*. They are separate:
- the **attempt key** is the txn id, minted fresh by every `begin`;
- the **dedupe key** is the semantic key (`site:s12@99`). It dedupes **effects and committed results**, never attempts.

A `begin` with a dedupe key:
1. an **open** txn holds the key: the call attaches to it (§3.12.8) and answers at its `EFFECTS_DONE`;
2. the cache holds a **committed** result for the key: replay it (`replayed()` = true), never run again;
3. the cache holds only **aborted** results for the key (a transient refusal, compensated): a **fresh attempt** with a new txn id. An
   aborted result is kept for tracing under its txn id, never as the key's answer;
4. nothing cached: a fresh attempt. After eviction, the kind's own evidence still decides (below): a committed removal's site is gone
   or its key credited, so it cannot run twice; an aborted one left the site standing, so the retry is legitimate.

**After eviction from the result cache**, a re-ask with the semantic key:
- finds the key in the pile's `credited` set, or the site gone with its key;
- answers from current state: `removed` = true, an empty `refund`, `replayed()` = true, and the detail "result evicted".

It never runs the operation again, and it never reports a refund it can't prove. Steward already reads refunds from the ledger
delta, not from a replayed answer (Steward's round-2 review §1).

### 3.8 A corrupt, partial or unknown entry

| Case | Behaviour |
|---|---|
| The file is partial or torn | Can't happen under P (atomic rename) or O (§3.1: forced before the rename, directory forced after) |
| `txn.json` doesn't parse | `loadFailed` for txns: nothing written, every item op refused up front, the legacy resolvers skip every resource, the file kept for ops. Fail closed |
| An entry fails its own validation (missing fields, negative amounts) | that entry is **quarantined**: left open, its resources held, logged at ERROR, `dev.txn.state` lists it. The others recover |
| An unknown `kind`, or `kv` newer than the build | quarantined as above. Never guessed |
| `txn.format` newer than the build | `loadFailed` for txns. While txns are open, the participant files' bumped FORMAT makes older builds fail closed too (§3.3) |
| A marker of an unknown txn in a BE | a stale marker (§3.7). Never acted on |
| A UNKNOWN probe that persists (a chunk that never loads, a deleted dimension) | held. `/architect txn resolve <id> abort\|commit` (§3.6: abort refused when the decision is APPLIED or UNKNOWN) |

### 3.9 Asynchronous chunk saves, kill points and the bulk streams

- **Asynchronous saves:** R-2 and R-3 make them harmless. An autosave, periodic save, chunk unload or logout at any instant
  persists only complete, marked effects. Chunks are probed one at a time. Entities are never a B store.
- **Unloaded chunks at recovery** get DR2's ticket: bounded at 8 loads a tick, DR2's `autoMaxLoads`. A txn waits rather than
  guesses.
- **Kill points:**
  - `Txn.step(name)` calls `WorldJournal.kill("TX:" + kind + ":" + name)` and records the name in a static registry. A new
    `dev.txn.points {kind}` lists every point of a kind, so the harness enumerates them (§4). `dev.journal.killAt` accepts any
    registered point.
  - `barrier()` adds `TXB1` (players on disk, chunks not), `TXB2` (chunks durable, ledger not) and `TXB3` (the ledger written,
    the directory not forced; a TEST-only `DIR_SYNC` swap, for units).
  - The existing names stay as **aliases** of the matching step while their gates exist: CS1, FKC1, FKC2, K5, K6, CXD1-4, AB1-4,
    OVD1, SAC1/2 and OV1, and **RVU1/RVU2 through T4** (Steward's e2e uses `RVU1+save` and `RVU2+save`; Steward's ask). The `+save` suffix works on every point.
- **Bulk streams stay outside TXN:**
  - the feed's per-cell consumption (row 27), at 4-16 cells a tick;
  - hopper and crate inserts (row 26);
  - staged terrain (row 35, which moves no items).

  A txn per cell would cost one fsync per block. Their recovery is RL's world-derived reconcile (cell books), which already
  re-derives from the world. Conservation still counts them (§5). The parts of those paths that are discrete operations do become
  txns: the bucket give-back, a reconcile's give-back (row 28), a deposit's ledger side.

### 3.10 Interaction with the WorldJournal

The journal stays the authority for cells. A removal has two journal effects:
- the **decision** (class D): the undo commit, whose `undoGroup` is the txn id, in the durable index;
- the **restore** (class W): the writes over ticks, completed and receipted per chunk.

At K6 the decision exists and the building still stands. Recovery replays the committed restore plan from the journal's undo
entries, which are retained until the txn retires, before any credit or record drop that depends on it. *(P1-2.)* `planUndo` and
hand-downs are unchanged. Today's `SiteJournal.reactivate` at start (`Sites` 3176) runs only for a removal whose txn is not
decided; it is the compensation of D. The journal's files get `DurableFile`.

### 3.11 Performance

Measured on this machine (M5 Max, APFS). The source is 994 `SS save:` lines from gate logs (gate-runs-LC3f 20261116-122948 and
-130515, gate-runs-r072-verify 20261115-195612).

| Cost | Today | With TXN |
|---|---|---|
| explicit save with the world (`saveWithWorld`) | p50 15.9 ms, p90 82.8 ms, max 1,395 ms; its `io` (forces) p50 7.4 ms, p90 54.5 ms | the same, as `barrier()` |
| ledger write | p50 0.3 ms, p90 0.6 ms, unforced | + one file force and one directory force (estimated 3-8 ms, measured in TXN-0) |
| `txn.json` write (new) | — | per txn: the intent, the decision, the retirement. Small file, forced: about 3-8 ms each (estimated; T0 measures it) |
| a single-site removal | 2-3 `saveWithWorld` (custody/pending, credit) | 3 `txn.json` writes + 2 barriers (before the decision, after the restore): about equal, plus roughly 10-25 ms of forces |
| a group removal | per member: a `saveCredit` (a world save) + a queue save | 1 intent write per removal; 1 barrier per **tick** (R-4b), not per member. Fewer world saves |
| a journal index commit | unforced (p50 in `dev.journal.state`) | + 2 forces per commit. **The biggest new cost**: every placement commits the index. TXN-0 measures it and records it (speed rule: record only) |
| the feed (bulk) | unchanged | unchanged |

The time is spent off the tick only where the existing writes already are (the journal IO thread). The ledger and barrier writes
stay on the server thread, as today.

### 3.12 API and compatibility

- **The public API (`dev.larattalabs.architect.api`):** additive members only (listed at the end of this section).
- **Reason:** none new. TXN unavailable answers `JOURNAL_UNAVAILABLE`; a resource held by an open txn answers `SITE_BUSY`.
- **Refunds and billing: semantics Steward reviewed** (steward-TXN-review.md, 2026-11-16: "nothing breaks"; its asks are adopted
  below):
  1. **When refunds appear.** A removal's refund still books at its member's settle. After a crash, recovery books it at the first
     tick. Steward reads state, not futures, at start: fine. Steward's OVF-S adds its own world-start "over capacity" line.
  2. **Over capacity** is the rule for every keyed refund (OVF (c); Noah's decision 7: OVF's owed stock over DR2's owed drops).
  3. **Held resources: `SITE_BUSY` with a detail, and a wait kind** (Steward's ask).
     - A refused call on a held resource answers `SITE_BUSY` with the detail "held: chunk x,z" or "held: player".
     - A target whose feed is skipped because its pile's transit is held reports **`SiteWait.TXN_HELD` = `"txn_held"`** (a new String
       constant beside `BILL_CAP`, Since NEXT, additive), not "short of materials".
     - Holds stay indefinite and ops-only, with no timeout (Noah's decision 4). A timeout can't replace missing evidence.
  4. **A decided removal completes, or ops abandon it** (§3.6). Steward already assumes removals end. On Steward's Q4, the decision
     is per group or stage (one journal undo commit), as today's R2:
     - blockers are checked before it, so "Undo stopped after N of M: blocked by …" keeps working;
     - after it, a player stepping in doesn't stop the restore (today's drop rule for their blocks applies).
  5. **Payouts to a player** are exactly once with the player attachment (from T7). Overflow is owed and collectible, never dropped
     (Noah's decision 1). Steward pays no player.
  6. **Futures** (Steward's Q1 and Q6). In-session futures (`remove`, `removeGroup`, `regions.remove`, `undoRevision`,
     `cancelBatch`) and `BATCH_DONE` complete at **`EFFECTS_DONE`**: every effect applied (the credits booked) and the barrier covering
     them succeeded. They do not wait for retirement.
     - If the txn becomes held before `EFFECTS_DONE` (a chunk unloads, a player leaves), the future completes exceptionally with
       `SITE_BUSY` and its detail. The txn finishes later, and its events then fire.
     - So no Steward busy mark outlives its call.
     - `WORLD_STOPPED` still fails pending futures at a stop.
  7. **Views** (Steward's Q2). Between the decision and `EFFECTS_DONE`:
     - the site stays listed as a pending removal (`SiteView` state as today's removal-in-progress);
     - `RevisionView.state` reads `UNDOING`;
     - `RegionView` reads its removing state.

     They read UNDONE, or are dropped, only at `EFFECTS_DONE` (the W restore and the credits done), so Steward never announces a
     restore that hasn't happened.
  8. **Re-asks and `RemoveResult.replayed()`** (Steward's Q5 and ask). A call with the same semantic key while its txn is open
     attaches to it: it answers at `EFFECTS_DONE` with the original `refund`. After retirement it answers from the `done` entry, and only
     a **committed** one (§3.7, round 4: an aborted attempt never answers a retry; the retry is a fresh attempt).
     Either answer has **`RemoveResult.replayed()` = true** (a new accessor; old constructors kept; Since NEXT; additive). Steward then
     doesn't say "Refunded" twice.
  9. **Events are at least once, with ids for tracing** *(round 2, P2-10; reworded in round 3 at Steward's ask)*.
     - Each event a txn fires is recorded in `events.emitted` after firing. A crash between firing and recording fires it again;
       a crash before firing fires it at recovery. So delivery is at least once, never lost.
     - **Consumers stay idempotent on their own saved state.** Steward's guards are `batchId`, the phase and the history, saved in
       the same file as their effect. The ids are **for tracing only**: no consumer keeps a seen-id set. A seen-id store would be a
       second file, and a crash between it and the consumer's own save would drop a needed delivery.
     - **When re-fired events fire** (Steward's R2-Q3): on the **first server tick after recovery**, never inside SERVER_STARTED,
       so listeners see a running server with every store loaded.
     - **An aborted txn** fires only what describes what really happened. A batch it ended fires `BATCH_DONE` (with today's not-placed
       fields). It never fires `SITE_REMOVED` or a stockpile change for a removal that was compensated.
     - **Where the ids go** *(round 3, P2-4)*. The existing callbacks keep their exact descriptors. `StockpileChanged.onChanged(String
       owner)` has no payload object to extend, and `SiteRemoved.onRemoved(SiteView, RemoveResult)` is a fixed signature too. So a
       **parallel event** carries the metadata:

       ```java
       Event<TxnEvent> TXN_EVENT;              // SiteEvents, Since NEXT
       interface TxnEvent { void onTxnEvent(TxnEventInfo e); }
       record TxnEventInfo(String txnId, String eventId, String kind, String subject, boolean replayed) {}
       // kind: "site_removed" | "batch_done" | "stockpile_changed" | "site_updated"; subject: the site id, batch id or owner
       ```

       `TXN_EVENT` fires immediately after each legacy event a txn fires, in the same tick and in the same order. A consumer that
       wants the id reads it there. Nothing existing changes.
  10. **The `SITE_BUSY` detail tells the two meanings apart** (Steward's R2-Q2):
      - `held(decided) tx-<n>: chunk x,z` or `... : player <name>`: **the caller's own decided txn** is held. It will finish later.
        Steward words it "under way". It is not a refusal, and no FAILED entry is written;
      - `held(other) tx-<n>: chunk x,z`: a **begin** refused because another txn holds the resource. Nothing changed; try later;
      - an empty detail: today's busy case (another build), unchanged.
  11. **Deltas get the detail too** (Steward's R2-Q1). `Refusal` gains a trailing `String detail` component, and the old 3-argument
      constructor is kept (additive, Since NEXT). A refused `applyDelta` on a held resource carries the same `held(...)` detail.
  12. **`owed` and collecting it** (Steward's R2-Q4).
      - **The shape:** `Stockpile.owed()` → `List<Owed>`, where `record Owed(String key, String recipient, String dimension,
        BlockPos at, Map<Item, Integer> items)` (Since NEXT; the record's old constructors kept).
      - **The recipient** is a player UUID or an owner id. For a modid owner such as `steward_mc:settlement/<id>`, only the owning mod
        collects, through a new `Stockpiles.collectOwed(owner, key, ServerPlayer to)` API (it decides which player receives), or
        through the stockpile panel's Take where that owner's Take is allowed today. Architect never hands a settlement's owed items
        to an arbitrary player.
      - **`/architect collect`** is open to every player for entries whose recipient is their own UUID. Ops (permission 2) may
        collect any entry, and that is logged.
      - **`adoptCrates`' over-capacity drop becomes owed** (Noah's decision 1). It is an owed entry for the adopting owner at the
        crate's cell, so `Adopted`'s `dropped()` reports what became owed.
- **API additions (all additive, Since NEXT, binary compatible; Steward review required):**
  - `SiteWait.TXN_HELD`;
  - `RemoveResult.replayed()`;
  - the parallel `SiteEvents.TXN_EVENT` with `TxnEventInfo` (existing callbacks unchanged);
  - `Refusal.detail` (with the old constructor kept);
  - `Stockpile.owed()` / `Owed`;
  - `Stockpiles.collectOwed`;
  - the `held(decided)` / `held(other)` detail text.

  `Reason` gains nothing.
- **Steward's views:** `Stockpile`/`StockLedger` views are unchanged, except that the stockpile view gains `owed` (collectibles,
  additive). The dev JSON gains `txn` (open ids, phases, held resources). DR2's `owedDrops` does not ship (Noah's decision 7).
- **Downgrade:** unsupported across TXN (§3.3, Noah's decision 3).

---

## 4. The crash harness

### 4.1 The unit level: `TxnCrashModel` (pure and exhaustive)

This is a test-only helper (`mod/src/test/.../txn/TxnCrashModel.java`). It needs no Minecraft and touches no runtime path. It
models the stores as snapshots:

Every participant is an independent store with its own **history** of persisted versions:
- `txn.json`;
- the ledger;
- each chunk (blocks and BEs, with their markers);
- each chunk's entities;
- each player;
- the queue;
- sites;
- each region record;
- the journal index;
- each journal entry file.

A kind's steps run against the model. At **every step, and for every combination of "which persisted version each participant is
at"** (each store at any version it wrote up to that step, independently of the others; an asynchronous save is just a version),
the model:

1. crashes;
2. reloads only the persisted snapshots;
3. runs `Txns.recover`;
4. asserts the conservation equation (§5) item for item, and that each L, B, W or R effect applied 0 or 1 times.

*(Revised: P2-8.)*

- **Bounds:** only the participants a kind touches vary. A version that a `DurableFile` or barrier confirmed is a floor: nothing
  older is chosen after it.
- **Sampling:** exhaustive for up to 4 chunks and 2 players. Beyond that, a seeded random sample (10,000 a kind), with the seed
  printed.
- **Failures as well as crashes:** each write can also fail before the rename, fail after the rename (the directory force throws),
  or be refused (SS). Each probe can go UNKNOWN, then become readable.
- **Load-time durability** *(round 3, P1-1)*. The model includes the sequence IN_DOUBT → process restart (the page cache kept, so
  the file loads) → an attempted retirement → power loss (the unforced rename lost). It asserts that no await, decision or
  retirement is satisfied by a loaded generation before load's re-force returned.
- **IO debt** *(round 3, P2-5)*. A chunk serialization failure, a write failure and an offline player's failed save are each
  retried by the model's barrier. It asserts the barrier refuses until the retry succeeds, and succeeds afterwards.
- **Recovery is crashed at every one of its own prefixes,** on both the redo and the compensation paths, and again inside the next
  recovery (bounded to depth 3).
- **Both branches of the decision** are covered: forward, and abort before the decision (a refused save, a thrown commit, an ended
  removal).
- **Failing first:** the same model replays today's code paths as "legacy kinds". OVF CS1, CXD3 and PSV's failed pre-save on main
  all go red here.

### 4.2 In game: `txn-crash`

- **The lib:** `tools/lib/gatetxn.mjs`, registered like CXD into `gate6dgr.mjs`. It uses its `haltWait`, `L.openWorld` and
  `L.fresh`, `dev.journal.killAt`, and the existing `+save` suffix.
- **Steps:**
  1. **Baseline first** *(round 2, P3-11)*:
     - prepare the scenario's world;
     - `/save-all flush`;
     - record `dev.txn.conservation` (§5);
     - copy the world directory with `cp -c -R` (an APFS clone, cheap) into the step's own run dir (rule 23).

     This clone is the baseline every case starts from.
  2. **Trace on a disposable copy:** clone the baseline again, open the clone, and run `dev.txn.trace {on: true}`, then the
     operation, then `dev.txn.trace {}`. The answer is the ordered list of points it hit (from `Txn.step` and the barrier's TXB
     points), so nothing is hand-listed. Then throw the copy away.
  3. **Per point P and variant V:**
     - **V = bare:** the halt, with nothing saved beyond what the operation saved.
     - **V = +save:** the existing variant, the chunks saved first.
     - **V = +async:** `dev.txn.asyncAt {point}` queues an unflushed `saveAllChunks(false)` and the periodic ledger save at P,
       waits for their IO, then halts. This is model A, which today's gates mostly miss.

     - **V = fail:** `dev.txn.failPersist` or `dev.queue.writes` at P (model R), with no halt, then the operation's unwind, then a
       halt and a restart.

     Then: restore the baseline clone, open, arm `P[+V]`, run the operation, `haltWait`, `openWorld`. Wait until
     `dev.txn.state.open` is 0, or until held is stable and names only declared UNKNOWN probes. Assert conservation exact
     against the baseline. Assert the
     operation's own outcome (stands or gone, by `committed`).
  4. **Crashes inside recovery:** for each point, the recovery's own steps (`TX:recover:<kind>:<step>`, redo and compensation)
     are traced on the restart, then each is armed in turn, then the world is restarted again.
  5. **Alternate paths:** a kind lists its scenario variants (a shared crate, a group, an unloaded crate chunk, an offline payee,
     a refused write). Each variant is traced separately, because one trace covers one path. *(P2-8.)*
- **Gate wiring:** each migrated kind adds one step `txn-crash-<kind>` to `gate-chains.json`, impact-mapped to `txn/**` and that
  kind's files. The runner's `--only`, `--no-cache`, `--shards 1` and `--no-turbo` apply as usual.
- **Size:** points × 3 variants. A single-site removal has about 7 points, so 21 cases. CXD's six cases fit one step; budget about
  1 min a case from CXD's run.
- **Dev hooks** (DEVBRIDGE, TEST):
  - `dev.txn.state`: open, held, quarantined, phases, applied hints;
  - `dev.txn.points {kind}`;
  - `dev.txn.trace`;
  - `dev.txn.asyncAt`;
  - `dev.txn.conservation`;
  - `dev.txn.failPersist {n}`: the next n intent writes fail (model R).

---

## 5. The conservation check

### 5.1 The equation

Per owner, and globally. It is a multiset of item ids, compared exactly against the baseline.

```
TOTAL =  inventories        (online players; offline players read from playerdata by the hook)
       + containers         (block containers in the box; crates excluded)
       + entities           (item entities in the box, every chunk of the box loaded first)
       + stock              (every pile's ledger stock)
       + paidStanding       (paid cells standing, XR-shadowed cells to their writer: Stockpiles.audit's rule)
       + crateStock         (every crate BE found by SCANNING the box's chunks, not only through site references)
       + custody + heldProvided (every pile's ledger)
       + fluidStanding + mechStanding   (audit's existing terms)
       + inTransit          (open txns: §5.2)
       + pendingCredits     (legacy, until row 17 migrates: held pending credits whose removal is committed)
       - injected           (what the harness inserted: dev.crate.insert, /give; as gate6crs's Conservation)
       - created + destroyed (§5.2)
       + owed               (every owed collectible, §3.4 O)
normalize(TOTAL) == normalize(BASELINE)      // base units after Equivalents, plus the conversion term
```

### 5.2 Counting each open txn exactly once

A naive sum double counts. At CXD2, for example, both the saved record and the still-full crate hold the stock. So owed records
(`crateOwed`, `owedDrops`, the queue's `decCredit`) are **never counted as records**. Each transfer effect has a source and a
sink, and an amount moving between them counts in exactly one place, by its probes:

The four probe states and where each counts:

| source | sink | forward (undecided or commit) | compensating (abort, or an abandon's unwritten members) |
|---|---|---|---|
| holds it (not taken, or given back) | not booked | the source | the source |
| taken | not booked | **inTransit** | **inTransit** |
| taken | booked | the sink | (not reachable: compensation unbooks first) |
| holds it again (compensated) | still booked | **violation** going forward | the sink, until its unbooking lands. The source's give-back persisted first: counted at the **sink only** |

*(Revised: P2-7.)* The compensation state is real: a restored container chunk can persist before the ledger lets go of the
custody. The probe tells them apart, because a compensated source carries `/i!c`. Conservation counts the amount once, at the
store still holding the txn's claim on it.

- **Conversions.** The comparison is in **base units after `Equivalents`** (`survival/Equivalents` 19: a log accepted as four
  planks). Each accept that converts records `{in, out}` in the ledger's existing bundle accounting, which the hook adds as a
  conversion term. Raw item ids are compared only where no conversion happened.
- **Intended creation and destruction** are explicit terms:
  - `created`: FK-b's provided items, written into a fill, unbilled (the ledger's `provided`);
  - `destroyed`: held provided items released and destroyed (`heldProvided`); a FREE cell's natural block cleared (§8a: no drops);
    a player-mined free cell (N-RS-2).

  `provided` (what a fill created) and `heldProvided` (custody of those items during a removal) are different ledger terms, and
  only the latter is a holding.
- **No loss term** (round 2, P2-9, Noah's decision 1). A drop is an owed collectible and counts as `owed` until it is collected (a P
  effect into an inventory). Any difference is a violation, never a "possible loss".

The hook computes `inTransit` from the open txns' probes, so it needs the layer. Until a kind migrates, its legacy state is a
named term with its own rule: pending credits count only while their removal is committed and the credit is not yet booked.

### 5.3 Where it hooks in

- **In the mod:** `dev.txn.conservation {owner?, min, max}` extends `Stockpiles.audit` (main 2243). It adds the crate scan,
  `custody`, `heldProvided`, `created`, `destroyed`, conversions, `inTransit`, `owed`, the offline inventories and `unread` (chunks it could not load: a
  non-empty `unread` makes the point **inconclusive**, never a pass).
- **In the gate:** `tools/lib/conservation.mjs` lifts `Conservation` out of `gate6crs-game.mjs` (gate6cy's copy follows), with the
  new terms. `gate-run.mjs` calls it after every strict scenario that declares `conservation: {owner, box}` in `gate-chains.json`,
  at scenario start and end and after each restart.
- **Report-only first:**
  - `GATE_CONSERVATION=report` is the default. It writes `artifacts/<run>/conservation.json` and a SUMMARY line, and never fails a
    step.
  - `=enforce` is per step, opt-in.
  - The default flips to enforce once T1 has run clean for one batch (Noah's decision 6).
- **Blind spots, written down:**
  - an item entity's despawn (6,000 ticks; scenarios read within the window);
  - hoppers carrying items out of the box (the box is the scenario's whole footprint plus 8);
  - another player's interaction;
  - fluids are counted only through audit's existing `fluidStanding`.
- **A prototype here:** not built. The hook is mod runtime (dev) code and `inTransit` needs the layer, so this slice is design
  only. The gate-lib lift is pure test tooling, but it is worth doing only with the hook.

---

## 6. Migration

### 6.1 The slices

| # | Slice | Contents | Tier | Size |
|---|---|---|---|---|
| T0 | **TXN-0 durable primitives** | `DurableFile` (PSV's writer, lifted); the ledger, sites, `RegionStore` and journal through it; per-chunk write acknowledgements, `.mcc` and save-off refusal (§3.1); `Stockpiles.barrier()` replacing `saveConfirmed` / `saveWithWorldConfirmed` / `durableBarrier`; `save()` no longer swallows failures; fault-injected units (directory sync, force failure, rename failure) | strict (journal, ledger) | 1 day |
| T1 | **TXN-1 core** | `txn.json`, `Txns`/`Txn`/`Effect`, the load/reconcile split (§3.6), recovery slot, holds honoured by the feed, inserts and seals, FORMAT bump while open, quarantine, kill-point registry, `dev.txn.*` hooks, `TxnCrashModel`, conservation hook report-only, `gatetxn.mjs`. No kind migrated except a test kind | strict | 2 days |
| T2 | **CXD on TXN** | `crate.take` (B), `removal.site` (single-site removal: custody B, journal undo W as decision, credit L, record R). CXD's `CrateOwed` table becomes the generic probe | strict | 1.5 days |
| T3 | **ADP on TXN** | `pile.adopt` (crate B + ledger L, SAC1/2 → steps). `crateFate` becomes the probe | strict | 0.5 day |
| T4 | **Group removals** | `removal.group` / `removal.stage`: `decCredit` / `decStock` → txn refs; `Groups.credit` → L effects per member, one barrier per tick; `end()` → compensation; `RestoreJob` roads | strict | 2-3 days |
| T5 | **LC3 abandon on TXN** | `removal.abandon`: custody return B (LC3's idempotent `writeBackAbandoned` + marker), release W, drop R | strict | 0.5 day |
| T6 | **Deltas, charges, scoops, fills, take-ups, repair, reconcile give-backs** | `delta.refund` (OVF's OVD1 → explicit decision; closes its leftover), with row 38's OVERWRITE drops owed (collectible), after the decision; `fill` (row 18, FK's FILLING becomes the intent); XR take-ups (row 11, `retakeOnce`/`retakeToPile`); repair settlement (DR2's record phases); `region.charge`, `region.scoop`, `mech.charge` (keyed, OVF (c)); RL reconcile give-backs (row 28) as L | strict | 1.5 days |
| T7 | **Leftovers and player moves** | rows 7-9 (road crate, complete leftovers, orphan crate: crate B → L when a pile exists, else an owed collectible); row 37 (adopted-site delta removal, as `removal.site`); dissolve's ground drop, the forced `removeCrate` and `withdraw`'s full-inventory overflow (owed collectibles, Noah's decision 1); `withdraw` and dissolve to a player, and deposits from a player (rows 23-25: P with the player attachment) | strict | 1.5 days |

**Every entry point is mapped** *(P2-9)*. Each of rows 1-38 is either in a slice above or excluded with its reason:
- rows 21, 34-36 move no items;
- rows 26-27 are bulk streams: §3.9, JR plus RL;
- row 5 is a guard, which goes with T4;
- row 32 is dropped with DR2's owed drops.

`node tools/txn-coverage.mjs` (T1, a source check) lists every caller of the item-moving primitives (`credit`, `charge`, `scoop`,
`takeStock`, `takeCustody`, `writeBack`, `giveBack`, `dropItems`, `dropOverflow`, `give`) and fails when one is neither inside a
txn kind nor on the exclusion list.

### 6.2 What each in-flight branch does

GATES rule 20 caps a NOT SAFE slice at one fix round plus a final pass. A P1 the final pass still finds goes **to Noah through the
parent**; TXN does not override that. *(P2-9.)* The proposal, per branch:
- if its final pass is clean, merge it as built;
- if a P1 remains, it is escalated under rule 20. When Noah decides, this design offers "move it onto TXN (slice Tn)" as one
  option, never as an automatic route.

| Branch | Recommendation | Keeps | Drops or moves | Risk |
|---|---|---|---|---|
| **PSV** | **Merge first**, as built. T0 lifts its writer | generations, `forceDir`, `Preflight`, NOT_SAVED refusals | `decStock` carriage moves to T4 | low; it is the primitive |
| **LC3** | rebase on PSV (its own plan), merge the seals as built | the seals, the FL holds, the round-4 abandon order | its generation copies (PSV's); abandon moves to T5 | the abandon's prefix rules are a hand-rolled txn until T5 |
| **OVF** | **merge as built** (a keyed single-write credit is already a one-effect txn) | the keyed never-overflow rule, `saveConfirmed` (until T0 renames it), OVD1 | OVD1's "drops unless rolled forward" leftover → T6 | `saveConfirmed` is not forced until T0 |
| **DR2** | **drop `OverflowDrops` / `oweDrop` / OV1** and rebase on OVF; keep the repair work | `durableBarrier` (until T0 makes it `barrier()`), MinedCells, the shadow rule, PT, save-off | the owed-drops handoff (row 32): it conflicts with OVF, and tag resolution is inconclusive after a pickup | moderate: DR2's DR7c/DR7o gate rows change to OVF's expectation (no entity) |
| **CXD** | finish its own gate and review under rule 20. Then T2 moves it onto TXN as the first real client. It is already the right shape | the record, the marker, the settle, the gate cases | `saveConfirmed` → T0 `barrier()`; its resolution table → probes; `crateOwed` → `txn.json` (the conversion protocol below) | the settle's drop becomes an owed collectible in T2 (Noah's decision 1) |
| **ADP** | finish as T3 (small), or merge as built | DEFER / JOIN | `crateFate` → probe | low |
| **ST / HB** | **merge as built**: no items move (FREE) | everything | their "flush before BUILT" (HB 1444) becomes a `barrier()` call in T0, a one-line swap | none for TXN. The BUILT-with-holes reopen is unit-only (HB's own leftover) |

**Order:**
1. PSV
2. OVF
3. ST/HB (independent)
4. LC3 (rebased) and DR2 (rebased on OVF, overflow dropped)
5. T0
6. T1
7. T2 (CXD)
8. T3 (ADP)
9. T4
10. T5
11. T6
12. T7

**T4 is the largest risk.** It changes the queue file's shape.

**The legacy conversion protocol** (T2 for `crateOwed`, T4 for `decCredit`/`decStock`, T6 for pending credits). *(P2-9.)* The
legacy resolvers stay in the code and keep running for legacy state until conversion is confirmed:
1. At start, a legacy record (a running removal with `decCredit`, an open `crateOwed`, a held pending credit) is read as it is.
2. Its txn is written to `txn.json` (`DurableFile`, confirmed), with phase decided by the evidence the legacy resolver uses today:
   the journal undo group, or the site's state. That evidence is recorded in the entry.
3. Only then is the legacy copy removed from its file, and that file's generation is awaited like any participant (§3.7).

A crash between steps 2 and 3 leaves both copies. The txn wins, the legacy resolver skips any record whose key has a txn, and the
copy is removed again. Until a world has no legacy record left, the legacy resolvers run after txn recovery on the resources no txn
holds.

---

## 7. How a slice follows rules 17 and 18 (once T1 lands)

**Rule 17:** every operation that moves items, billing or refunds is a txn kind.
1. Plan all amounts.
2. `persist()`.
3. Apply effects with their markers.
4. One `barrier()` before any irreversible step.
5. Decide once.
6. Finish.

A slice that can't fit this shape says why in its contract. Reviewers check R-1 to R-8 (§3.5), not a bespoke table.

**Rule 18:** the slice's strict gate includes `txn-crash-<kind>`:
- every traced point × {bare, +save, +async};
- conservation **enforced** for that step;
- failing first: the same matrix on main's path, red, recorded in the as-built.

`TxnCrashModel` cases go in its units. Before T1, a slice follows rule 18 the way CXD and LC3 round 4 did: units modelling the
stores at every step, plus a hand-listed in-game crash step with gate6crs's `Conservation`.

---

## 8. Noah's decisions (Noah via parent session, 2026-11-17)

The round-1 open questions are settled:
1. **Drops and full-inventory overflow stay collectible (owed); no uncertain loss.** §3.4 O, R-5 and §5. Class E is gone.
2. **LC3's abandon versus an irrevocable R2: settled in this round.** A decided removal completes, or ops abandon it by the
   takeover protocol in §3.6 (T5). LC3 is likely to ship without abandon, so abandon arrives in T5.
3. **Downgrading worlds that hold transactions is unsupported** (dev mode). §3.3.
4. **UNKNOWN holds stay indefinite and ops-only; no timeout.** §3.6, §3.12 (Steward's timeout ask is declined; its busy marks are
   protected by futures completing with `SITE_BUSY` instead).
5. **Batched journal forces are accepted** if T0's measured cost is reasonable. §3.1.
6. **Conservation stays report-only until T1 runs clean for one batch, then it is enforced.** §5.3.
7. **OVF's owed stock over DR2's owed drops.** §6.2.

No question is open for Noah. Steward's Q1-Q6 are answered in §3.12.

## 9. What the harness won't catch

- **Missing fsyncs (model O).** A halt keeps the page cache. Only the T0 fault-injected units and source checks (every store write
  goes through `DurableFile`; a lint that refuses `Files.move(... ATOMIC_MOVE)` outside it) catch them.
- **Windows directory sync.** PSV treats it as best effort.
- **Collecting owed items across a crash** is a P txn and is covered. What is not covered is a player who never returns: their
  owed items and P effects stay held, by design (Noah's decision 4).
- **A real `.mcc` external chunk, or a real IO failure before the region file,** unless a unit injects it. The barrier refuses it
  by design (§3.1).
- **Unloaded chunks at recovery,** unless a case unloads them on purpose (`dev.txn.state.held`).
- **Multiplayer interleavings,** other mods' hoppers or item pipes, and vanilla's own hopper/crate chunk-boundary dupes (row 26,
  not Architect's).
- **Disk full in the middle of a rename.** Units only.
- **Bulk streams** (feed, inserts). Conservation counts them, but their crash windows are RL's reconcile, not TXN's.
- **The sampled region of the model.** Beyond 4 chunks and 2 players, `TxnCrashModel` samples (§4.1); a seed reproduces a failure,
  but an unsampled case can't fail.

## 10. Revision after the GPT review (gpt-6.1-sol, max effort, read-only; verdict NOT SOUND; one revision pass)

| Finding | Change |
|---|---|
| P1-1: an intent written into `stockpiles.json` publishes unrelated bulk ledger state (a hopper's credit) ahead of its chunks | intents moved to `architect/txn.json` (§3.2). The ledger is published only by `barrier()`, which keeps JR/HF's order (R-4a) |
| P1-2: the journal decision is not completion (K6: decided, nothing restored) | separate D (decision) and W (restore, per chunk, receipted after a barrier); credits wait for W; undo entries kept until retirement (§3.4, §3.10, R-6) |
| P1-3: UNKNOWN holds weren't enforced on the feed, inserts, menus or resolvers; start-up reconciles inside load | holds honoured by every writer through the seal / FillHold index; the load/reconcile split; ops `abort` refused when the decision is APPLIED or UNKNOWN (§3.6) |
| P1-4: retirement before queue/sites generations; deleted records can't carry markers; one BE marker per effect | `retiring` awaits every participant's generation; drop tombstones; a BE marker list with compensation markers (§3.3, §3.4, §3.7) |
| P1-5: P/E have no conclusive probe, so the redo can pay twice | P gets a player attachment (exactly once at that player's load); E gets a durable claim before the spawn, never replayed, plus a loss receipt (§3.4) |
| P1-6: an empty `undurable` list doesn't prove the chunk was written (`.mcc`, failures before the file) | per-chunk write acknowledgements; `.mcc` and save-off refuse the barrier; `RegionStore` and new directories forced; the O guarantee narrowed to acknowledged chunks (§3.1) |
| P2-7: conservation's compensation state, conversions, provided vs heldProvided, possible vs actual loss | a compensating column; base units after `Equivalents` plus a conversion term; `created`/`destroyed` terms; loss = durable receipts only (§5) |
| P2-8: the harness isn't exhaustive (independent chunk histories, journal entry files, recovery prefixes, the abort matrix, alternate paths) | per-participant version histories; failure injection; recovery crashed at every prefix on both paths; variants traced separately (§4) |
| P2-9: unmapped paths (fill, withdraw, XR, repair, the adopted-site delta, OVERWRITE drops); the legacy shim; rule 20 | audit rows 37-38; T6/T7 widened; `txn-coverage.mjs`; a conversion protocol; P1s escalate under rule 20 (§1.3, §6) |
| P2-10: downgrade protection abandoned | FORMAT + 1 on the participant files while a txn is open (§3.3, §3.12) |
| P2-11: Steward-visible semantics understated | six items listed: irrevocable after the decision, player payouts, futures and events across a crash, unbounded holds (§3.12) |
| P3-12: absolutes beyond the evidence (LC3's force, the store count, unverified A windows) | qualified by revision; 8 stores; rows 18-19's A windows withdrawn as hypotheses (§1) |

Not re-reviewed: the brief allows one revision pass. A final GPT pass on this revision would be the next step if Noah wants one
(GATES rule 20 applies to slices that build code. This is a design, so the decision is the coordinator's).

## 11. Round 2 (the final GPT pass, Steward's review, Noah's decisions)

The final GPT pass (the log the coordinator ran) returned NOT SOUND with 6 P1s, 4 P2s and 1 P3. It called the layer
"buildable". Each finding and its change:

| Finding | Change |
|---|---|
| P1-1: acknowledgements cover only the txn's chunks, but the barrier publishes the whole ledger | the barrier is **global**: save epochs, every chunk, entity and player write of the epoch acknowledged, failures owed until rewritten, the periodic save a barrier too (§3.1) |
| P1-2: player saves are not acknowledged (vanilla swallows failures); `withdraw` overflow drops | a player-save acknowledgement mixin; P retires only on an acknowledged save with the receipt; overflow owed (§3.1, §3.4, decision 1) |
| P1-3: retirement waits on JVM-local generations | `store` id + `gen` persisted inside every `DurableFile`; the ledger carries its `epoch`; awaits are `{store, gen}` and `{epoch}` (§3.1, §3.7) |
| P1-4: a restore deletes the crate BE that carries the marker | receipts in a **chunk attachment** that survives the BE's replacement, plus the confirmed `PREPARED_DONE` boundary (§3.4) |
| P1-5: a post-rename failure is read as "not committed" | `DurableFile` answers `IN_DOUBT`: the store keeps the new version, retries, and the txn holds; `JournalStore.fail`'s revert goes (§3.1) |
| P1-6: no directory force for a new `.mca` or a player file replace | mixins force the region and `playerdata` directories; the barrier waits for them; Windows is best effort, and the guarantee is narrowed there (§3.1) |
| P2-7: LC3's abandon versus irrevocable R2; player-first payouts too early | the abandon takeover protocol on the same txn (T5); txn removals refuse abandon until T5; `withdraw` and dissolve keep `saveLedgerFirst` until T7 (§3.6, §3.1) |
| P2-8: the older-reader refusal doesn't exist for sites and the queue | the claim is withdrawn; downgrade unsupported (decision 3); the ledger's FORMAT + 1 kept only as a partial net (§3.3) |
| P2-9: an E claim can't prove a loss | class E is removed; drops are owed collectibles; no loss term in conservation (§3.4, §5, decision 1) |
| P2-10: exactly-once events are impossible with Fabric callbacks | at least once with `txnId` / `eventId`, recorded after firing, re-fired at recovery; Steward dedupes by id (§3.12 item 9) |
| P3-11: the harness's baseline was taken after the traced run | baseline first, then trace on a disposable copy (§4.2) |

**Steward's asks** (steward-TXN-review.md), adopted in §3.12:
- Q1/Q6: futures and `BATCH_DONE` complete at `EFFECTS_DONE`, or fail with a `SITE_BUSY` detail if the txn is held; `WORLD_STOPPED`
  still fails them.
- Q2: views read UNDOING until the restore and the credits are done.
- Q3: `SiteWait.TXN_HELD`.
- Q4: one decision per group or stage, with blockers checked before it.
- Q5: a re-ask attaches to the txn, answering with `RemoveResult.replayed()`.
- The RVU1/RVU2 aliases stay through T4.
- The hold timeout is declined (decision 4).

**T0** is being built on `slice/T0`. When this round was written it had no commits, so §3.1 follows T0's brief. It must be checked
against T0's as-built when that lands.

Not re-reviewed here: the coordinator runs the final GPT pass.

## 12. Round 3 (the third GPT pass and Steward's round 2; Noah: "One last round")

The third GPT pass came back NOT SOUND, with two P1s against the design and two P1s against T0's initial commit, plus three P2s.
It marked most of round 2 resolved.

| Finding | Change |
|---|---|
| P1-1: a generation loaded at start is not proof it is durable (IN_DOUBT → restart → power loss) | load re-forces the installed file and its directory before `writtenGen` acknowledges anything; until then the store is IN_DOUBT; the sequence is in the crash model (§3.1, §4.1). T0's fix round implements it |
| P1-2: the recovery predicate lost decisions (EFFECTS_DONE without COMMITTED; ABANDONED ignored) | an immutable `decision` field separate from `phase`; a phase × decision × evidence table; EFFECTS_DONE stays committed; abandon resumes its recorded split (§3.3, §3.6) |
| P1 (T0 042da098): player saves acknowledged without the replace result | positive acknowledgement: `safeReplaceOrMoveFile`'s result plus a read-back hash plus forces (§3.1). For T0's fix round |
| P1 (T0 042da098): `forceDir` turned every directory error into OK | best effort only for the named Windows limit; any other failure after a rename is IN_DOUBT (§3.1). For T0's fix round |
| P2-3: compaction dropped the promised results and event payloads | `done` keeps the semantic key, the terminal result and pending event payloads until the emitted bookkeeping is acknowledged; a bounded result cache; eviction answers `replayed()` with an empty refund, never a re-run (§3.7) |
| P2-4: `StockpileChanged(String owner)` can't gain fields | a parallel `SiteEvents.TXN_EVENT` (`TxnEventInfo`), fired right after each legacy event; the existing descriptors unchanged (§3.12.9) |
| P2-5 (also T0): failure debt with no retry | a failed chunk's dirty state restored or its snapshot requeued, and the chunk pinned; online players re-saved; offline players' snapshots rewritten from a debt table (§3.1) |

**Steward's round 2:**
- §3.12.9 reworded: ids are for tracing, and consumers stay idempotent on their own saved state, with no seen-id set.
- R2-Q1: `Refusal.detail` (§3.12.11).
- R2-Q2: `held(decided)` versus `held(other)` (§3.12.10).
- R2-Q3: re-fired events fire on the first tick after recovery; an aborted txn fires only `BATCH_DONE` for the batch it ended; the
  ids travel on `TXN_EVENT` (§3.12.9).
- R2-Q4: the `Owed` shape, owner-only collection through `collectOwed` for modid recipients, `/architect collect` for one's own
  entries (ops for any), and `adoptCrates`' overflow becomes owed (§3.12.12).

**T0:** §3.1 uses T0's names (`OK` / `REFUSED` / `IN_DOUBT`). The load re-force, the player acknowledgement and the directory rule
follow T0's fix-round brief. When I wrote this, origin/slice/T0 was still at 042da098; check §3.1 against it once its fix round lands.

Not re-reviewed here: the coordinator runs the final GPT pass.

### 12.1 Round 4 edits (the fourth GPT pass, TXN-gpt4.log; Noah approved them for T1)

The fourth pass came back NOT SOUND with two P1s (both for T0's fix round: ancestor-directory confirmation, and the player snapshot at
login), two P2s and one P3. Its "safe to start" table marks T1 safe in part (core scaffolding, holds, the model, hooks and the harness).
The design edits, made on `slice/T1`:

| Finding | Change |
|---|---|
| P2-3: event payloads captured at `EFFECTS_DONE`, after `record.drop` may have destroyed their source | the immutable event source data is written in the intent (`payloads`) by `persist()`, before any effect; the abort path writes its own payload (an owed `BATCH_DONE`) with `decision: abort` (§3.3, §3.7, R-1) |
| P2-4: a cached aborted attempt answers a legitimate retry | the attempt key (the txn id, fresh per begin) is separate from the dedupe key (the semantic key); only committed results replay; an aborted result never answers its key (§3.3, §3.7, §3.12.8) |
| P3-5: the §3.3 example had two `decision` members; `done` was ids only; 1,024 vs 4,096 | the journal descriptor is `decider`; `done` entries are `{id, key, decision, result, payloads}`; one bound, the result cache's 4,096 (§3.3) |
| Implementation constraint: native chunk unload proceeds after `save` returns | retention intercepts the unload boundary itself, not a ticket added after the save (§3.1, failure debt) |
| P1-1, P1-2 (T0) | not design edits: T0's fix round implements them. T1's `TxnCrashModel` encodes both as counterexamples |

