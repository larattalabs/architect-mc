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
true. The one exception is class E (an item entity, §3.4): at most once, by a durable claim, with a loss receipt. A player's inventory
is exactly once through a player attachment, completed at that player's next load.

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

- **Applied to:**
  - `txn.json` (new);
  - the ledger (`stockpiles.json`);
  - the queue (PSV, as is);
  - the sites file (adding the directory force);
  - `RegionStore` (adding the directory force);
  - the world journal's index and entry files (adding both forces; §3.11 gives the cost).

  A newly created directory (`architect/`, a journal section folder) gets its parent forced once.
- `Stockpiles.save()` returns the generation, or fails. An IOException is no longer swallowed.
- **One barrier replaces four primitives:** `saveConfirmed`, `saveWithWorldConfirmed`, `durableBarrier` and the quiet path's
  silent return become `Stockpiles.barrier()`.
  - The barrier runs players, then a flushed chunk save known durable by `RegionDurability.undurable("chunk","entities")`, then the
    ledger through `DurableFile`.
  - It returns `Barrier{ledgerGen, worldEpoch}` or throws `NotDurable`.
  - Callers that today use `saveWithWorld` for a txn step call `barrier()`.
  - **What the barrier proves, narrowed** *(P1-6)*. `RegionDurability.undurable` empty means "every write that reached a region file
    is covered by a successful force". It does not prove that a participating chunk was serialized and written: a write can fail
    before it reaches the file, or go to an external `.mcc` payload (`RegionDurability` 32-33). So a txn's barrier also requires:
    - **a per-chunk write acknowledgement** for every chunk the txn touched since its last barrier. A mixin on the chunk storage's
      store future records success per chunk position and epoch; a failure, or no acknowledgement, means `NotDurable`;
    - **a participating chunk written as an external `.mcc` is NotDurable** (fail closed: vanilla never forces it). The txn waits,
      and the ops log names the chunk;
    - **`/save-off` (`noSave`) refuses the barrier**, as DR2's `savingOff`.

    The O guarantee is therefore "for chunks the barrier acknowledged". Anything else holds the txn.
- **Windows:** opening a directory for a force can fail. PSV logs it once and treats it as best effort; that stays.

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
      "id": "tx-1041", "kind": "removal.site", "kv": 1, "phase": "PREPARED",
      "at": {"tick": 123456, "wall": 1731800000000}, "who": "architect:steward | <uuid> | null",
      "resources": ["site:s12", "crate:minecraft:overworld@10,64,-3", "box:minecraft:overworld@..", "pile:steward:town"],
      "decision": {"kind": "journal", "undoGroup": "tx-1041"},
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
      "claims": []
    }
  ],
  "retiring": [{"id": "tx-1039", "await": {"queue": 88, "sites": 412, "ledger": 977}}],
  "done": ["tx-1038"]
}
```

- **`id`:** `tx-<n>`, where `next` is persisted. Each effect's idempotency key is `tx-1041/3`. The existing semantic keys
  (`site:<id>@<placedAt>`, `adopt:...`, `delta:...`, `crate:...`) stay on L effects as `key`. The `credited` set dedupes them, so a
  re-begun operation can't pay twice.
- **`kind` + `kv`:** the kind's schema version. An unknown kind, or a `kv` newer than this build's, is quarantined (§3.8).
- **`phase`:** `PREPARED`, `COMMITTED` or `ABORTING`. A finished txn moves to `retiring` (§3.7), then to `done` (the last 1,024
  ids).
- **`effects`:** the whole plan with every amount, written **before** any effect runs (R-1). The queue, sites and region records
  hold only the txn id (`"txn": "tx-1041"`), never amounts (R-7). `decCredit` and `decStock` go.
- **`receipts`:** hints only, saved when the file is next written. Recovery decides from the stores' own markers (§3.4), never from
  a receipt, with one exception: a **claim** (`claims`, §3.4 class E) is authoritative by design.
- **`txn.format` and downgrades:**
  - While `open` or `retiring` is non-empty, `stockpiles.json`, `architect-queue.json` and `architect-sites.json` are written with
    their FORMAT **bumped by one**. An older build's `newerFormat` check (`Stockpiles` 3027, and the same check in the queue and
    sites loaders) then refuses them and fails closed, instead of overwriting state that has items in flight.
  - Once the last txn retires, the next writes use the normal FORMAT again, so a clean stop leaves a world older builds can open
    (§3.12). *(Revised: P2-10.)*

### 3.4 Effects: classes by how recovery can observe them

*(Revised: P1-2, P1-4, P1-5.)*

| Class | Store | Marker / receipt (same atomic unit as the effect) | Probe | Guarantee |
|---|---|---|---|---|
| **L** ledger | `stockpiles.json` | the key in the pile's `credited` (or `applied`) set | read it | exactly once |
| **B** block entity | chunk | a **list** in the BE's NBT, `architect_mc:txn = ["tx-n/i", "tx-n/i!c", ...]`, written with the change. A forward effect adds `tx-n/i`; its compensation adds `tx-n/i!c` (the original entry stays). Several txns and effects can mark one BE | APPLIED: `/i` present, `!c` absent. COMPENSATED: both. ABSENT: neither. UNKNOWN: chunk unloaded or BE unreadable | exactly once while the BE exists |
| **D** decision (journal) | world-journal index | `undoGroup = tx id` on the entries' meta, in the durable index commit (`DurableFile`, §3.1) | read the index | exactly once; it is only the decision |
| **W** world restore | chunks | none of its own: completion is **per chunk** by state. Every cell holds its planned value (`planUndo`'s rule: a cell is restored only while it holds `after`). Plus a **per-chunk receipt** once a barrier covered that chunk | per chunk: DONE (receipt and state agree), PARTIAL, UNKNOWN | idempotent; the journal entries are **kept until the txn retires** |
| **R** record | queue / sites / region | an upsert carries `txn`. A **drop** leaves a tombstone in the txn entry (`dropped: {store, gen}`), because a deleted record can't carry a marker | upsert: the record has `txn`. Drop: the record is absent **and** that store's written generation is at least the tombstone's | exactly once |
| **P** player inventory | `playerdata` | a **player attachment** (Fabric data attachment, saved in `player.dat` with the inventory) holding `["tx-n/i", ...]`, written in the same change as the inventory edit | at that player's next load: APPLIED / ABSENT. Offline: UNKNOWN **for that effect only** | exactly once. A held txn waits for that player only |
| **E** item entity | `entities/` | a **claim**: `claims += {i, attempt}` written to `txn.json` (`DurableFile`) **before** the entities spawn. A claimed attempt is never replayed, whatever the world shows | the claim is authoritative | at most once. A claim not settled at retirement becomes a durable **loss receipt** (items, where, why) |

- **E is forbidden by default (R-5).** It is allowed only for a terminal drop where no store can take the items (no pile and no
  crate: CXD's player-crate settle; dissolve's ground drop).
- **Same-chunk monotonicity** may be used only for effects whose markers are still present. A marker that a later write could
  overwrite or delete (a restored cell that removes the crate BE) is never the only evidence. *(P1-4.)* The design keeps an effect's
  evidence in the txn entry (the planned states, the tombstones) until it retires.
- **Chunks and their entities are separate storages.** No probe crosses them.

### 3.5 The rules a txn kind must obey

- **R-1 Plan before persist.** Every amount is computed and nothing is mutated.
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
- **R-5 No entities in a txn** (class E only as in §3.4).
- **R-6 One decision.** Before it, every applied effect is compensable; after it, every remaining effect is redo-able from the entry.
  The decision is `phase: COMMITTED` in `txn.json`, or a D effect (the journal undo group). **The decision is not completion:** a
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
    decided = phase == COMMITTED || probe(D) == APPLIED          // UNKNOWN D: hold
    if !decided:   compensate every APPLIED B/P/L/R effect, newest first (compensation markers: idempotent); phase ABORTING -> retire
    else:          for each effect in order: if probe != APPLIED/DONE: apply (W per chunk, ticketed loads, at most 8 a tick)
    any UNKNOWN:   keep held; retry when its chunk or player loads
  retiring: confirm the awaited generations (§3.7)
```

- **Exactly once:**
  - each effect probes its own store's marker, or its claim for E;
  - a compensation leaves its own marker;
  - a second crash at any prefix of recovery replays from the same entry and the same markers.
- **The ops command** `/architect txn resolve <id> commit|abort`, permission 2, logged:
  - `abort` is refused when the decision probe is APPLIED **or UNKNOWN**. An external commit always wins.
  - `commit` is refused while a PREPARED txn's own prepare effects are UNKNOWN.

### 3.7 Retirement and compaction

*(Revised: P1-4.)*

A finished (or aborted) txn moves to `retiring` with the generations it awaits: the ledger holding its last L effect, the queue
and sites holding its last record change and its tombstones, a region's record, and the barrier epoch covering its last chunk
effects. It leaves `retiring` only when every awaited generation is confirmed written (`DurableFile.written`). Until then:
- its journal entries are kept;
- its holds stay (only the resources whose evidence is still awaited);
- a stale queue or sites reference to it still finds its entry.

B and P markers of a txn in `done` are stale. They are cleared the next time their BE or player is written, and never read as
evidence again (an insert refusal keys on an **open** txn). A clean stop finishes what it can. A held txn survives the stop (and
keeps the bumped FORMAT, §3.3).

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

- **The public API (`dev.larattalabs.architect.api`):** **no change** is required.
- **Reason:** none new. TXN unavailable answers `JOURNAL_UNAVAILABLE`; a resource held by an open txn answers `SITE_BUSY`.
- **Refunds and billing: no API signature changes, but the semantics change. Steward must review them** *(P2-11)*:
  1. **When refunds appear.** A removal's refund still books at its member's settle (unchanged). After a crash, recovery books it
     at the first tick, before any resolver. Steward's views may see the credit a few ticks earlier than with
     `settlePendingCredits`, never twice.
  2. **Over capacity.** OVF's "past capacity, never dropped" becomes the rule for every keyed refund (already in OVF's contract:
     `refundOverflow` stays 0 for keyed refunds; `usedStacks > capacityStacks` possible).
  3. **Held resources.** While a txn waits on an unloaded chunk or an offline player, operations on **its** resources answer
     `SITE_BUSY`. Today the same cases silently guess. A hold is scoped to the txn's resources, but an owner's billing touching a
     held pile's transit amount can wait as long as the hold lasts (unbounded while a chunk never loads; the ops command ends it).
  4. **A decided removal always completes.** After the decision (R2), a crash never brings the site back. Today's evidence-based
     recovery (`Sites.reconcile` RECOVER, `SiteJournal.reactivate`) can restore a standing site's record when its writes didn't
     land. Under TXN it does so only before the decision.
  5. **Payouts to a player** (`withdraw`, dissolve to the player) become exactly once by the player attachment, and complete at
     that player's next load if a crash came between. Dissolve's ground drop and CXD's player-crate drop are claims: at most once,
     with a loss receipt.
  6. **Results and events across a crash.** A caller's future (`RemoveResult`, its `refund`) never completes after a crash: the
     caller re-reads the site and the stockpile. A recovered removal fires `SITE_REMOVED` and the stockpile change events **once,
     when it retires**, never at both the original call and the recovery. A retry of the same request is idempotent by the
     semantic key: the second answers the first's outcome.
- **Steward's views:** `Stockpile`/`StockLedger` views are unchanged. The dev JSON gains `txn` (open ids, phases, held
  resources). DR2's `owedDrops` would **not** ship (§6).
- **Downgrade:** while a txn is open, the participant files carry FORMAT + 1, so an older build refuses them (fail closed) instead
  of losing items in flight. A clean stop with nothing held writes the normal FORMAT, so a downgrade then works. *(P2-10.)* Units:
  an older reader refuses each bumped file. Open question 3 becomes only "is fail closed acceptable after a crash".

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
  1. **Trace:** `dev.txn.trace {on: true}`, run the operation once, `dev.txn.trace {}`. The answer is the ordered list of points it
     hit (from `Txn.step` and the barrier's TXB points), so nothing is hand-listed.
  2. **Baseline:** `/save-all flush`, copy the world directory with `cp -c -R` (an APFS clone, cheap) into the step's own run dir
     (rule 23), and record `dev.txn.conservation` (§5).
  3. **Per point P and variant V:**
     - **V = bare:** the halt, with nothing saved beyond what the operation saved.
     - **V = +save:** the existing variant, the chunks saved first.
     - **V = +async:** `dev.txn.asyncAt {point}` queues an unflushed `saveAllChunks(false)` and the periodic ledger save at P,
       waits for their IO, then halts. This is model A, which today's gates mostly miss.

     - **V = fail:** `dev.txn.failPersist` or `dev.queue.writes` at P (model R), with no halt, then the operation's unwind, then a
       halt and a restart.

     Then: restore the baseline clone, open, arm `P[+V]`, run the operation, `haltWait`, `openWorld`. Wait until
     `dev.txn.state.open` is 0, or until held is stable and names only declared UNKNOWN probes. Assert conservation exact
     against the baseline (plus loss receipts, which must be empty unless the case crashes inside a claimed E attempt). Assert the
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
       + lossReceipts       (durable receipts of class E claims that did not settle)
normalize(TOTAL) == normalize(BASELINE)      // base units after Equivalents, plus the conversion term
```

### 5.2 Counting each open txn exactly once

A naive sum double counts. At CXD2, for example, both the saved record and the still-full crate hold the stock. So owed records
(`crateOwed`, `owedDrops`, the queue's `decCredit`) are **never counted as records**. Each transfer effect has a source and a
sink, and an amount moving between them counts in exactly one place, by its probes:

The four probe states and where each counts:

| source | sink | forward (PREPARED or COMMITTED) | compensating (ABORTING) |
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
- **Loss** is only what a durable **loss receipt** (§3.4 E) records, and never a "possible" loss. Receipts are bounded (the last
  1,024, with item totals per owner kept forever), so a long-lived world's loss stays accountable.

The hook computes `inTransit` from the open txns' probes, so it needs the layer. Until a kind migrates, its legacy state is a
named term with its own rule: pending credits count only while their removal is committed and the credit is not yet booked.

### 5.3 Where it hooks in

- **In the mod:** `dev.txn.conservation {owner?, min, max}` extends `Stockpiles.audit` (main 2243). It adds the crate scan,
  `custody`, `heldProvided`, `created`, `destroyed`, conversions, `inTransit`, loss receipts, the offline inventories and `unread` (chunks it could not load: a
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
| T0 | **TXN-0 durable primitives** | `DurableFile` (PSV's writer, lifted); the ledger, sites, `RegionStore` and journal through it; per-chunk write acknowledgements, `.mcc` and save-off refusal (§3.1); `Stockpiles.barrier()` replacing `saveConfirmed` / `saveWithWorldConfirmed` / `durableBarrier`; `save()` no longer swallows failures; fault-injected units (directory sync, force failure, rename failure) | strict (journal, ledger) | 1 day |
| T1 | **TXN-1 core** | `txn.json`, `Txns`/`Txn`/`Effect`, the load/reconcile split (§3.6), recovery slot, holds honoured by the feed, inserts and seals, FORMAT bump while open, quarantine, kill-point registry, `dev.txn.*` hooks, `TxnCrashModel`, conservation hook report-only, `gatetxn.mjs`. No kind migrated except a test kind | strict | 2 days |
| T2 | **CXD on TXN** | `crate.take` (B), `removal.site` (single-site removal: custody B, journal undo W as decision, credit L, record R). CXD's `CrateOwed` table becomes the generic probe | strict | 1.5 days |
| T3 | **ADP on TXN** | `pile.adopt` (crate B + ledger L, SAC1/2 → steps). `crateFate` becomes the probe | strict | 0.5 day |
| T4 | **Group removals** | `removal.group` / `removal.stage`: `decCredit` / `decStock` → txn refs; `Groups.credit` → L effects per member, one barrier per tick; `end()` → compensation; `RestoreJob` roads | strict | 2-3 days |
| T5 | **LC3 abandon on TXN** | `removal.abandon`: custody return B (LC3's idempotent `writeBackAbandoned` + marker), release W, drop R | strict | 0.5 day |
| T6 | **Deltas, charges, scoops, fills, take-ups, repair, reconcile give-backs** | `delta.refund` (OVF's OVD1 → explicit decision; closes its leftover), with row 38's OVERWRITE drops moved after the decision as a claim or into the pile; `fill` (row 18, FK's FILLING becomes the intent); XR take-ups (row 11, `retakeOnce`/`retakeToPile`); repair settlement (DR2's record phases); `region.charge`, `region.scoop`, `mech.charge` (keyed, OVF (c)); RL reconcile give-backs (row 28) as L | strict | 1.5 days |
| T7 | **Leftovers and player moves** | rows 7-9 (road crate, complete leftovers, orphan crate: crate B → L when a pile exists, else a claimed E); row 37 (adopted-site delta removal, as `removal.site`); dissolve's ground drop and the forced `removeCrate` (claimed E); `withdraw` and dissolve to a player, and deposits from a player (rows 23-25: P with the player attachment) | strict | 1.5 days |

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
| **CXD** | finish its own gate and review under rule 20. Then T2 moves it onto TXN as the first real client. It is already the right shape | the record, the marker, the settle, the gate cases | `saveConfirmed` → T0 `barrier()`; its resolution table → probes; `crateOwed` → `txn.json` (the conversion protocol below) | the settle's LF1 drop stays a declared E loss until open question 1 |
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

## 8. Open questions for Noah

1. **Where the stock goes when a player crate has no pile.** CXD's settle drops the crate's stock at its cell: an entity, at most
   once, a declared loss window inside the drop's save. Keep that, or give every player site an owed ledger entry ("collect at
   the crate's cell" through the panel), which makes it exactly once at the cost of a UX change?
2. **The journal's fsync cost.** Forcing the index and entries on every commit is new (§3.11). Accept it, recording only, or batch
   the journal's forces per tick?
3. **Downgrades.** While a txn is open, the participant files carry FORMAT + 1, so an older build refuses the world (fail closed)
   until the newer build has finished the txn (§3.3). Accept that "after a crash, open it once with the newer build" rule?
4. **Conservation enforcement.** Flip from report to enforce after one clean batch, or keep report-only until the T4 migration?
5. **Holds with no end.** A txn waiting on a chunk that never loads, or on a player who never returns, holds its resources until
   the ops command. Add an automatic timeout that settles it as a loss receipt (for example after 7 days), or keep it ops-only?
6. **DR2 versus OVF.** Confirm OVF's (c) ("a keyed refund never overflows") as the rule, and drop DR2's owed drops.

## 9. What the harness won't catch

- **Missing fsyncs (model O).** A halt keeps the page cache. Only the T0 fault-injected units and source checks (every store write
  goes through `DurableFile`; a lint that refuses `Files.move(... ATOMIC_MOVE)` outside it) catch them.
- **Windows directory sync.** PSV treats it as best effort.
- **Entity pickups between crashes.** Players race the E effects. These are claimed (at most once, with a loss receipt). The
  harness checks that a claim is never replayed, not whether the player got the items.
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

