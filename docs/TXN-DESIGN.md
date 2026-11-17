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
- §8 Open questions for Noah
- §9 What the harness won't catch

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
true. The exceptions are the two declared at-most-once effects (§3.4: a player's inventory and item entities). They lose items and
never dupe them, and they say so in the log.

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

Seven stores and four durability rules. No operation that moves items touches only one of them.

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
| 18 | Fill (FK) | `Fills.step` 591-699: FILLING (setPhase), FK1, locks + `purse.pay` + container writes + `markFilled`, FK2, sWW 694, FILLED, FK4 | an intent in the sites record, then one sWW | **A**: an autosave between FK1 and FK2's sWW persists the containers before the ledger (the charge). Replay relies on FILLING | — |
| 19 | Custody take | `Fills.takeCustody` 804-860 | containers cleared + `holdCustody` in memory; the caller saves | **A**: the container chunk saved empty before the ledger holds the custody (autosave between). The caller's sWW narrows it, it does not close it | LC3 |
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

**Headline:** 36 paths. 31 move items or billing (rows 21, 34, 35 and 36 move none, and row 5 is a guard). **29** of the 31 have
a known P, A or R crash window on main or on their branch. Two of them (rows 24 and 30) are the declared LF1 window: a loss,
never a dupe. Row 27's window is closed by RL's reconcile, except for its bucket overflow. **Every** row is exposed under the O model, because neither the ledger nor the journal
is forced. Eight in-flight branches fix about 20 of them, each with its own primitive.

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

### 3.1 Step 0: one durable write primitive (`DurableFile`)

PSV's queue writer, generalized and named, with its `writeSave` / `forceDir` / generation counters lifted out of `Placement`
(`site/DurableFile.java`):

```java
final class DurableFile {
  long request();                      // the next generation for this file (no IO)
  boolean write(byte[] bytes, long gen); // tmp, force(true), ATOMIC_MOVE, force(dir); then writtenGen = gen. False on any failure
  boolean written(long gen);           // writtenGen >= gen and no failure since gen was requested
  long writtenGen(); boolean failing();
  static DirSync DIR_SYNC;             // TEST seam (PSV's)
}
```

- **Applied to** the ledger (`stockpiles.json`), the queue (PSV, as is), the sites file (adding the directory force) and the world
  journal's index and entry files (adding both forces; §3.11 gives the cost).
- `Stockpiles.save()` returns the generation, or fails. An IOException is no longer swallowed.
- **One barrier replaces four primitives:** `saveConfirmed`, `saveWithWorldConfirmed`, `durableBarrier` and the quiet path's
  silent return become `Stockpiles.barrier()`.
  - The barrier runs players, then a flushed chunk save known durable by `RegionDurability.undurable("chunk","entities")`, then the
    ledger through `DurableFile`.
  - It returns `Barrier{ledgerGen, worldEpoch}` or throws `NotDurable`.
  - Callers that today use `saveWithWorld` for a txn step call `barrier()`.
- **Windows:** opening a directory for a force can fail. PSV logs it once and treats it as best effort; that stays.

### 3.2 Where the journal lives: inside `stockpiles.json`

The intent records go in a top-level `txn` section of the ledger file. This generalizes CXD's `crateOwed`.

**Why there:**
- **The pairing:** the most common pair is "intent + ledger booking". In one file they land in one atomic rename, so the booking
  and the intent can't disagree. That is OVF's single-write insight and CXD's choice.
- **Corruption** of the file is already handled: `loadFailed` means nothing is saved and every survival removal is refused up
  front (PS F6, PSV P1-2). TXN inherits that fail-closed rule; it adds no second corruption path.
- **Saving:** the file is written whenever a txn is open, even with no pile (CXD does this already).

**Rejected: a separate append-only log** (`architect/txn.log`, framed records with CRC32C):
- a second fsync on every operation;
- its own torn-tail and CRC rules;
- a two-file commit between the intent and the ledger booking, the very class we are removing.

The cost of the chosen place is write amplification: the whole ledger is rewritten for each intent. Gate worlds' ledgers are
4.2 KB median and 6.2 KB max (38 files in run dirs). The measured unforced write is p50 0.3 ms, p90 0.6 ms (`write` in 818 `SS
save:` lines). If a real world's ledger grows past about 1 MB (cell books on a large town), the books move to a sibling file
(open question 5).

### 3.3 The entry schema (format 1)

```json
"txn": {
  "format": 1,
  "next": 1042,
  "open": [
    {
      "id": "tx-1041",
      "kind": "removal.site", "kv": 1,
      "phase": "PREPARED",
      "at": {"tick": 123456, "wall": 1731800000000},
      "who": "architect:steward | <uuid> | null",
      "resources": ["site:s12", "crate:s12@10,64,-3", "pile:steward:town"],
      "decision": {"store": "txn"} ,
      "effects": [
        {"i": 0, "op": "crate.take",   "store": "chunk", "dim": "minecraft:overworld", "pos": [10,64,-3],
         "items": {"minecraft:oak_planks": 12}, "src": "crate:s12", "dst": "transit"},
        {"i": 1, "op": "custody.take", "store": "chunk", "pos": [..], "items": {..}, "src": "container", "dst": "transit"},
        {"i": 2, "op": "journal.undo", "store": "journal", "entries": [".."], "undoGroup": "tx-1041"},
        {"i": 3, "op": "ledger.credit","store": "ledger", "pile": "steward:town", "key": "site:s12@99",
         "items": {..}, "src": "transit", "dst": "stock"},
        {"i": 4, "op": "record.drop",  "store": "sites", "site": "s12"}
      ],
      "applied": [0, 1],
      "declaredLoss": {}
    }
  ],
  "done": ["tx-1039", "tx-1040"]
}
```

- **`id`:** `tx-<n>`, where `next` is persisted. The ids are the idempotency keys (`tx-1041/3`). The existing semantic keys
  (`site:<id>@<placedAt>`, `adopt:...`, `delta:...`, `crate:...`) stay on ledger effects as `key`. They dedupe a re-begun operation,
  which the `credited` set already enforces.
- **`kind` + `kv`:** the per-kind schema version. A reader that meets an unknown kind, or a `kv` newer than its own, does not guess
  (§3.8).
- **`phase`:**
  - `PREPARED`: the intent is durable, nothing is decided.
  - `COMMITTED`: the decision is durable; finishing forward only.
  - `ABORTED`: undoing.

  There is no `DONE` phase on disk: a finished txn leaves `open` (§3.7).
- **`effects`:** the whole plan, with every amount, written **before** any effect runs (rule R-1). The queue and sites records
  hold only the txn id (`"txn": "tx-1041"`), never amounts (R-7). `decCredit` and `decStock` go.
- **`applied`:** what the txn knows it applied. It is a hint only, saved opportunistically. Recovery never trusts it over the
  stores' own markers (§3.5), because an asynchronous save can persist a store ahead of the ledger.
- **`declaredLoss`:** the items an at-most-once effect may have lost in a crash window. Conservation reads it (§5).
- **Format versioning:** `txn.format` is separate from the file's FORMAT. A newer `txn.format` makes the session `loadFailed` for
  txns only: the file is never written, and every item op is refused. Older builds ignore the `txn` key. That is the downgrade risk
  in §3.12.

### 3.4 Effects: classes by how recovery can observe them

Each effect is one of these classes. The class fixes its marker, its probe and the guarantee it gives.

| Class | Store | Marker (same atomic unit as the effect) | Probe at recovery | Guarantee | Precedent |
|---|---|---|---|---|---|
| **L** ledger | `stockpiles.json` | the effect key in the pile's `credited` (or `applied`) set, **in the same file as the intent** | read it | exactly once | OVF (c), J2 pending |
| **B** block entity | chunk | `architect_mc:txn = "tx-n/i"` in the BE's NBT, written with the change (CXD's `CxdTaken` generalized) | read the BE: MARKED / PRESENT / ABSENT | exactly once, while the chunk is readable. UNKNOWN while it isn't | CXD, LC3 `writeBackAbandoned` |
| **W** world cells | chunk via WorldJournal | the journal entry's `undoGroup = txn id` | the journal index (durable, §3.1), then the cell state (`planUndo` restores only cells holding `after`) | exactly once (idempotent by state) | the journal's own rules |
| **R** record | sites / queue / region | the record carries `txn` | read the record | exactly once (idempotent upsert or drop) | PSV generations |
| **P** player inventory | `playerdata` | none possible: a player can be offline, and the inventory can't be read back at start | — | **at most once**, by ledger-first order (LF), with the amount added to `declaredLoss` before the move | J1 / HF LF1 |
| **E** item entity | `entities/` | a tag (DR2), but a pickup or despawn removes it | inconclusive | **forbidden by default**. Allowed only as a terminal drop where no store can take the items (no pile, no crate). At most once, declared loss | OVF (c), CXD settle |

**Same-chunk monotonicity:** a chunk save is a snapshot of the whole chunk. If a later effect in a chunk is visible, every
earlier effect of the same txn in that chunk is visible too. This is CXD's "ABSENT means the take preceded it". A probe may use
it inside one chunk, **never across chunks**, and never between a chunk and its entities (they are separate storages).

### 3.5 The rules a txn kind must obey

- **R-1 Plan before persist.** Every amount is computed (tallies, crate stock, custody contents, refunds) and nothing is mutated.
- **R-2 Persist before mutate (rule 17).** The intent reaches the disk through `DurableFile` before the **first in-memory change**
  of any store that an asynchronous save can persist. That covers the ledger, block entities, containers, the queue and records.
  Executor completion or the saver's turn is not persistence. If the write fails, nothing is touched (`JOURNAL_UNAVAILABLE`).
- **R-3 Marker with the effect.** Each L, B, W or R effect writes its marker in the same atomic unit as its change. Then any
  combination of P, A or O leaves each effect either fully visible or fully absent.
- **R-4 Chunks versus the ledger.** Inside a txn there is **no ordering rule** between chunk saves and ledger saves: markers make
  every order recoverable, so the asynchronous save is harmless. Instead:
  - (a) an irreversible step outside the txn waits for a `barrier()` that covers every effect applied before it. That covers the
    journal undo commit, an unseal, a record drop, and the end of a txn.
  - (b) there is **at most one barrier per step and per tick**, never one per effect. A group removal's members share their tick's
    barrier.
  - (c) outside a txn (the bulk streams, §3.9) JR's rule stays: the ledger is never ahead of the chunks.
- **R-5 No entities in a txn.** An outcome goes into a store that holds a marker: the pile's ledger (OVF (c): past capacity,
  never dropped) or the crate. Class E only as in §3.4.
- **R-6 One decision.** Each kind names its decision. Before it, every applied effect is compensable; after it, every remaining
  effect is redo-able from the entry alone. The decision is one of:
  - `phase: COMMITTED` written through `DurableFile` (the default);
  - an external atomic commit that carries the txn id. The only one is the journal undo group (`undoGroup == tx id` in the durable
    index).
- **R-7 One copy of each amount.** Records point at the txn and never copy amounts.
- **R-8 One recovery slot** (§3.6).

### 3.6 The API and the recovery algorithm

```java
package dev.larattalabs.architect.txn;

Txn t = Txns.begin(Kind.REMOVAL_SITE, resources);   // refused: TXN unavailable (loadFailed) or a resource held by an open txn (SITE_BUSY)
t.plan(Effect.crateTake(level, pos, items));         // R-1: plans only; no store touched
t.plan(Effect.journalUndo(ids));
t.plan(Effect.ledgerCredit(pile, key, items));
t.persist();                                         // R-2: the intent durable (DurableFile); throws NotDurable, nothing touched
t.step("take");  t.apply(0);                         // the BE change and its marker; kill point TX:removal.site:take
t.barrier();                                         // R-4a: one barrier before the irreversible step
t.apply(1);                                          // the journal undo commit with undoGroup = t.id(): the decision (R-6)
t.commit();                                          // phase COMMITTED (folded into the next ledger write if the decision is external)
t.apply(2); t.done();                                // the credit lands with the txn leaving `open` in ONE ledger write
```

```java
interface Effect {
  Probe probe(Ctx c);       // APPLIED | ABSENT | UNKNOWN (its chunk not loaded, the BE unreadable, the player offline)
  void apply(Ctx c);        // idempotent: a no-op when probe() == APPLIED
  void compensate(Ctx c);   // only before the decision; idempotent
  Map<String,Integer> moves(); String from(); String to();  // for conservation (§5)
}
```

**Recovery (`Txns.recover`)** has one slot. It runs at SERVER_STARTED after the ledger, sites, queue, regions and world journal
have loaded, and **before** every feature resolver: `settlePendingCredits`, `CrateOwed.atStart`, `Fills.atStart`,
`reconcileAtStart`, `repairJoinedCrates` and the Groups resume. Those resolvers are deleted as their kinds migrate.

```
for each open txn, oldest first:
  committed = phase == COMMITTED || (decision is external && probe(decision) == APPLIED)
  probes = effects.map(probe)            // UNKNOWN chunks: ticketed (DR2's ticket), probed at the first tick they load
  if any probe UNKNOWN: keep the txn open, its resources held (SITE_BUSY to new ops), retry each tick; dev.txn.state names it
  else if committed: for each effect not APPLIED, in order: apply      (redo)
  else:              for each APPLIED effect, in reverse: compensate   (undo); phase ABORTED
  done(): leaves `open` in the same ledger write as the last ledger effect, after a barrier covering the chunk effects
```

- **Exactly once:** each effect's probe answers from its own store's marker (§3.4), and an L effect and the txn's exit are one
  write. A second crash during recovery replays from the same entry. The work done is the same, because each effect is a no-op
  once applied.
- **Locks:** `resources` are held in memory while a txn is open, including after a restart. A conflicting `begin` is refused
  `SITE_BUSY` (an existing Reason). That keeps a replay's world unchanged under it.

### 3.7 Compaction

- A finished txn leaves `open` in the ledger write that applies its last ledger effect. A txn with no ledger effect leaves at the
  next ledger write after its covering barrier.
- `done` keeps the last 1,024 ids, for diagnostics and to recognise stale markers. Nothing else is kept. The pile's `credited`
  keys stay as they are today (they are the semantic dedupe).
- **Stale markers:** a B marker whose txn is neither open nor in the queue's current refs is settled. It is cleared the next time
  its block entity is written, and it is never read as "taken" again. CXD's insert refusal on a marked crate keys on an **open**
  txn.
- **A clean stop** (SERVER_STOPPING) finishes or aborts every txn it can. One that is UNKNOWN stays, and the stop logs it.

### 3.8 A corrupt, partial or unknown entry

| Case | Behaviour |
|---|---|
| The file is partial or torn | Can't happen under P (atomic rename) or O (§3.1: forced before the rename, directory forced after) |
| The file doesn't parse, or `txn` is malformed | the existing `loadFailed`: nothing written, every item op refused up front, the file kept for ops. Fail closed |
| An entry fails its own validation (missing fields, negative amounts) | that entry is **quarantined**: left open, its resources held, logged at ERROR, `dev.txn.state` lists it. The others recover |
| An unknown `kind`, or `kv` newer than the build | quarantined as above. Never guessed |
| `txn.format` newer than the build | `loadFailed` for txns (see §3.3) |
| A marker of an unknown txn in a BE | a stale marker (§3.7). Never acted on |
| A UNKNOWN probe that persists (a chunk that never loads, a deleted dimension) | held. An ops command `/architect txn resolve <id> abort\|commit` (permission 2, as LC3's abandon) decides it, logged; it is refused while a probe is readable |

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
  - The existing names (CS1, FKC1, FKC2, K5, K6, CXD1-4, AB1-4, OVD1, SAC1/2, OV1) stay as **aliases** of the matching step
    while their gates exist. The `+save` suffix works on every point.
- **Bulk streams stay outside TXN:**
  - the feed's per-cell consumption (row 27), at 4-16 cells a tick;
  - hopper and crate inserts (row 26);
  - staged terrain (row 35, which moves no items).

  A txn per cell would cost one fsync per block. Their recovery is RL's world-derived reconcile (cell books), which already
  re-derives from the world. Conservation still counts them (§5). The parts of those paths that are discrete operations do become
  txns: the bucket give-back, a reconcile's give-back (row 28), a deposit's ledger side.

### 3.10 Interaction with the WorldJournal

The journal stays the authority for cells. TXN does not replace it: a removal's undo commit is an effect (class W) whose
`undoGroup` is the txn id. That makes the journal index the external decision of the `removal.*` kinds. `planUndo` and
hand-downs are unchanged. The journal index and its entry files get `DurableFile` (§3.1); that is the one change inside the
journal.

### 3.11 Performance

Measured on this machine (M5 Max, APFS). The source is 994 `SS save:` lines from gate logs (gate-runs-LC3f 20261116-122948 and
-130515, gate-runs-r072-verify 20261115-195612).

| Cost | Today | With TXN |
|---|---|---|
| explicit save with the world (`saveWithWorld`) | p50 15.9 ms, p90 82.8 ms, max 1,395 ms; its `io` (forces) p50 7.4 ms, p90 54.5 ms | the same, as `barrier()` |
| ledger write | p50 0.3 ms, p90 0.6 ms, unforced | + one file force and one directory force (estimated 3-8 ms, measured in TXN-0) |
| a single-site removal | 2-3 `saveWithWorld` (custody/pending, credit) | 1 intent write + 1 barrier + 1 final ledger write: about equal |
| a group removal | per member: a `saveCredit` (a world save) + a queue save | 1 intent write per removal; 1 barrier per **tick** (R-4b), not per member. Fewer world saves |
| a journal index commit | unforced (p50 in `dev.journal.state`) | + 2 forces per commit. **The biggest new cost**: every placement commits the index. TXN-0 measures it and records it (speed rule: record only) |
| the feed (bulk) | unchanged | unchanged |

The time is spent off the tick only where the existing writes already are (the journal IO thread). The ledger and barrier writes
stay on the server thread, as today.

### 3.12 API and compatibility

- **The public API (`dev.larattalabs.architect.api`):** **no change** is required.
- **Reason:** none new. TXN unavailable answers `JOURNAL_UNAVAILABLE`; a resource held by an open txn answers `SITE_BUSY`.
- **Refunds and billing: no API change, but flagged for Steward review.** Three behaviours are visible:
  1. **When refunds appear.** A removal's refund still books at its member's settle (unchanged). After a crash, recovery books it
     at the first tick, before any resolver. Steward's views may see the credit a few ticks earlier than with
     `settlePendingCredits`, never twice.
  2. **Over capacity.** OVF's "past capacity, never dropped" becomes the rule for every keyed refund (already in OVF's contract:
     `refundOverflow` stays 0 for keyed refunds; `usedStacks > capacityStacks` possible).
  3. **Held resources.** While a txn waits on an unloaded chunk, operations on its resources answer `SITE_BUSY`. Today the same
     cases silently guess.
- **Steward's views:** `Stockpile`/`StockLedger` views are unchanged. The dev JSON gains `txn` (open ids, phases, held
  resources). DR2's `owedDrops` would **not** ship (§6).
- **Downgrade:** an older build ignores the `txn` key and rewrites the file without it. **Items in flight in an open txn are lost
  on a downgrade.** A clean stop leaves `open` empty (§3.7), so the risk is a downgrade after a crash. Open question 3.
- **The file format:** additive key, no FORMAT bump (as CXD's `crateOwed`).

---

## 4. The crash harness

### 4.1 The unit level: `TxnCrashModel` (pure and exhaustive)

This is a test-only helper (`mod/src/test/.../txn/TxnCrashModel.java`). It needs no Minecraft and touches no runtime path. It
models the stores as snapshots:

- the ledger file;
- each chunk (blocks and BEs, with their markers);
- each chunk's entities;
- players;
- the queue;
- sites;
- the journal index.

A kind's steps run against the model. At **every step, and every subset of "which stores' latest in-memory state an
asynchronous save persisted"**, the model:

1. crashes;
2. reloads only the persisted snapshots;
3. runs `Txns.recover`;
4. asserts the conservation equation (§5) item for item, and that each L, B, W or R effect applied 0 or 1 times.

The subsets are bounded: per step, each store is persisted or not, giving 2^7 at most, and much less in practice because only the
stores a kind touches vary.

Recovery runs twice per case, for the second-crash-during-recovery rows. The same model replays today's code paths as
"legacy kinds", written failing first: OVF CS1 and CXD3 on main both go red here.

### 4.2 In game: `txn-crash`

- **The lib:** `tools/lib/gatetxn.mjs`, registered like CXD into `gate6dgr.mjs`. It uses its `haltWait`, `L.openWorld` and
  `L.fresh`, `dev.journal.killAt`, and the existing `+save` suffix.
- **Steps:**
  1. **Trace:** `dev.txn.trace {on: true}`, run the operation once, `dev.txn.trace {}`. The answer is the ordered list of points it
     hit (from `Txn.step` and the barrier's TXB points), so nothing is hand-listed.
  2. **Baseline:** `/save-all flush`, copy the world directory with `cp -c -R` (an APFS clone, cheap) into the step's own run dir
     (rule 23), and record `dev.txn.conservation` (§5).
  3. **Per point P and variant V:**
     - **V = bare:** the halt, with nothing saved beyond what the operation saved.
     - **V = +save:** the existing variant, the chunks saved first.
     - **V = +async:** `dev.txn.asyncAt {point}` queues an unflushed `saveAllChunks(false)` and the periodic ledger save at P,
       waits for their IO, then halts. This is model A, which today's gates mostly miss.

     Then: restore the baseline clone, open, arm `P[+V]`, run the operation, `haltWait`, `openWorld`. Wait until
     `dev.txn.state.open` is 0, or until held is stable and names only declared UNKNOWN probes. Assert conservation exact
     against the baseline (less `declaredLoss`, which must be empty unless the kind declares a P or E effect). Assert the
     operation's own outcome (stands or gone, by `committed`).
  4. **The second crash:** for each committed point, a run that arms `TX:recover:<i>` (the recovery's own steps) once.
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
       + custody + provided (every pile's ledger)
       + fluidStanding + mechStanding   (audit's existing terms)
       + inTransit          (open txns: §5.2)
       + pendingCredits     (legacy, until row 17 migrates: held pending credits whose removal is committed)
       - injected           (what the harness inserted: dev.crate.insert, /give; as gate6crs's Conservation)
       + declaredLoss       (open and recent txns' at-most-once losses; must be empty unless the scenario crashes inside a P/E effect)
TOTAL == BASELINE
```

### 5.2 Counting each open txn exactly once

A naive sum double counts. At CXD2, for example, both the saved record and the still-full crate hold the stock. So owed records
(`crateOwed`, `owedDrops`, the queue's `decCredit`) are **never counted as records**. Each transfer effect has a source and a
sink, and an amount moving between them counts in exactly one place, by its probes:

| source probe | sink probe | counted at |
|---|---|---|
| ABSENT (not taken) | ABSENT | the source (already in containers, crateStock or stock) |
| APPLIED (taken) | ABSENT | **inTransit**: the txn's effect amount |
| APPLIED | APPLIED | the sink (already in stock, crateStock or ...) |
| ABSENT | APPLIED | impossible by R-6. Reported as a **violation**, never balanced |

The hook computes `inTransit` from the open txns' probes, so it needs the layer. Until a kind migrates, its legacy state is a
named term with its own rule: pending credits count only while their removal is committed and the credit is not yet booked.

### 5.3 Where it hooks in

- **In the mod:** `dev.txn.conservation {owner?, min, max}` extends `Stockpiles.audit` (main 2243). It adds the crate scan,
  `custody`, `provided`, `inTransit`, `declaredLoss`, the offline inventories and `unread` (chunks it could not load: a
  non-empty `unread` makes the point **inconclusive**, never a pass).
- **In the gate:** `tools/lib/conservation.mjs` lifts `Conservation` out of `gate6crs-game.mjs` (gate6cy's copy follows), with the
  new terms. `gate-run.mjs` calls it after every strict scenario that declares `conservation: {owner, box}` in `gate-chains.json`,
  at scenario start and end and after each restart.
- **Report-only first:**
  - `GATE_CONSERVATION=report` is the default. It writes `artifacts/<run>/conservation.json` and a SUMMARY line, and never fails a
    step.
  - `=enforce` is per step, opt-in.
  - The default flips to enforce after one batch with zero false reds (Noah's call, open question 4).
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
| T0 | **TXN-0 durable primitives** | `DurableFile` (PSV's writer, lifted); the ledger, sites and journal through it; `Stockpiles.barrier()` replacing `saveConfirmed` / `saveWithWorldConfirmed` / `durableBarrier`; `save()` no longer swallows failures; fault-injected units (directory sync, force failure, rename failure) | strict (journal, ledger) | 1 day |
| T1 | **TXN-1 core** | `txn` section, `Txns`/`Txn`/`Effect`, recovery slot, locks, quarantine, kill-point registry, `dev.txn.*` hooks, `TxnCrashModel`, conservation hook report-only, `gatetxn.mjs`. No kind migrated except a test kind | strict | 2 days |
| T2 | **CXD on TXN** | `crate.take` (B), `removal.site` (single-site removal: custody B, journal undo W as decision, credit L, record R). CXD's `CrateOwed` table becomes the generic probe | strict | 1.5 days |
| T3 | **ADP on TXN** | `pile.adopt` (crate B + ledger L, SAC1/2 → steps). `crateFate` becomes the probe | strict | 0.5 day |
| T4 | **Group removals** | `removal.group` / `removal.stage`: `decCredit` / `decStock` → txn refs; `Groups.credit` → L effects per member, one barrier per tick; `end()` → compensation; `RestoreJob` roads | strict | 2-3 days |
| T5 | **LC3 abandon on TXN** | `removal.abandon`: custody return B (LC3's idempotent `writeBackAbandoned` + marker), release W, drop R | strict | 0.5 day |
| T6 | **Deltas, charges, scoops, reconcile give-backs** | `delta.refund` (OVF's OVD1 → explicit decision; closes its leftover); `region.charge`, `region.scoop`, `mech.charge` (keyed, OVF (c)); RL reconcile give-backs (row 28) as L | strict | 1.5 days |
| T7 | **Leftovers** | rows 7-9 (road crate, complete leftovers, orphan crate: crate B → L when a pile exists, else a declared E); dissolve ground drop and the forced `removeCrate` (E declared); deposit ledger side | strict | 1 day |

### 6.2 What each in-flight branch does

GATES rule 20 caps a NOT SAFE slice at one fix round plus a final pass. The proposal, per branch:
- if its next review is clean, merge it as built;
- if it would need another patch round, move the P1 onto TXN instead.

| Branch | Recommendation | Keeps | Drops or moves | Risk |
|---|---|---|---|---|
| **PSV** | **Merge first**, as built. T0 lifts its writer | generations, `forceDir`, `Preflight`, NOT_SAVED refusals | `decStock` carriage moves to T4 | low; it is the primitive |
| **LC3** | rebase on PSV (its own plan), merge the seals as built | the seals, the FL holds, the round-4 abandon order | its generation copies (PSV's); abandon moves to T5 | the abandon's prefix rules are a hand-rolled txn until T5 |
| **OVF** | **merge as built** (a keyed single-write credit is already a one-effect txn) | the keyed never-overflow rule, `saveConfirmed` (until T0 renames it), OVD1 | OVD1's "drops unless rolled forward" leftover → T6 | `saveConfirmed` is not forced until T0 |
| **DR2** | **drop `OverflowDrops` / `oweDrop` / OV1** and rebase on OVF; keep the repair work | `durableBarrier` (until T0 makes it `barrier()`), MinedCells, the shadow rule, PT, save-off | the owed-drops handoff (row 32): it conflicts with OVF, and tag resolution is inconclusive after a pickup | moderate: DR2's DR7c/DR7o gate rows change to OVF's expectation (no entity) |
| **CXD** | **don't run another fix round**; finish as T2 (the first real client). If Noah needs it sooner, merge as built: it is already the right shape | the record, the marker, the settle, the gate cases | `saveConfirmed` → T0 `barrier()`; its resolution table → probes; `crateOwed` → `txn.open` (a load step reads a leftover `crateOwed` as open `crate.take` txns) | the settle's LF1 drop stays a declared E loss until open question 1 |
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

**T4 is the largest risk.** It changes the queue file's shape. A queue written by an older build (with `decCredit`) loads as legacy
until its removal ends: a load-time shim maps a running legacy removal to a `removal.group` txn in PREPARED or COMMITTED, decided by
the journal's undo group. It is the one inference left, and it is written once.

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

## 8. Open questions for Noah

1. **Where the stock goes when a player crate has no pile.** CXD's settle drops the crate's stock at its cell: an entity, at most
   once, a declared loss window inside the drop's save. Keep that, or give every player site an owed ledger entry ("collect at
   the crate's cell" through the panel), which makes it exactly once at the cost of a UX change?
2. **The journal's fsync cost.** Forcing the index and entries on every commit is new (§3.11). Accept it, recording only, or batch
   the journal's forces per tick?
3. **Downgrades.** An older build drops the `txn` section. Refuse to open a world with open txns on an older build (impossible to
   enforce from the newer side), or accept "a downgrade after a crash may lose items in flight" as documented?
4. **Conservation enforcement.** Flip from report to enforce after one clean batch, or keep report-only until the T4 migration?
5. **Ledger size.** If a large world's ledger passes about 1 MB, move the cell books to a sibling file (they are derived and
   rebuildable)?
6. **DR2 versus OVF.** Confirm OVF's (c) ("a keyed refund never overflows") as the rule, and drop DR2's owed drops.

## 9. What the harness won't catch

- **Missing fsyncs (model O).** A halt keeps the page cache. Only the T0 fault-injected units and source checks (every store write
  goes through `DurableFile`; a lint that refuses `Files.move(... ATOMIC_MOVE)` outside it) catch them.
- **Windows directory sync.** PSV treats it as best effort.
- **Entity pickups between crashes.** Players race the E and P effects. These are declared losses, not checked.
- **Unloaded chunks at recovery,** unless a case unloads them on purpose (`dev.txn.state.held`).
- **Multiplayer interleavings,** other mods' hoppers or item pipes, and vanilla's own hopper/crate chunk-boundary dupes (row 26,
  not Architect's).
- **Disk full in the middle of a rename.** Units only.
- **Bulk streams** (feed, inserts). Conservation counts them, but their crash windows are RL's reconcile, not TXN's.
