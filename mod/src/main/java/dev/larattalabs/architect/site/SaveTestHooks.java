package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLevelEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * (slice SOFF2, TEST, {@code dev.stockpile.ps}) The soff-crash, fk-crash, xr-survival and ps-crash rows' hooks: each fires once, only in its
 * window, and does nothing unarmed. Server thread.
 * <ul>
 * <li>{@code savingOffAtStart}: a marker in {@code <world>/architect/}; at the next start every level loads with saving off (as another mod
 * would turn it off before the start's reconcile), the marker then deleted;</li>
 * <li>{@code failLedgerWrites}: every stockpile ledger write fails (as a full disk), until turned off or the JVM ends;</li>
 * <li>{@code noSaveInCreditSave}: a level's saving turned off from BEFORE_SAVE inside the next credit save (a refund's save with the world);</li>
 * <li>{@code depositInSavingOffBarrier}: the player's Insert from inventory, from BEFORE_SAVE inside /save-off's barrier;</li>
 * <li>{@code rawSaveIn}: {@code playerSave} (inside the next player save of a world save, before the players are written) or {@code beforeSave}
 * (inside the next world save's BEFORE_SAVE): another mod's {@code saveAllChunks(true, true, true)}; {@code haltAfter}: the JVM halted
 * right after it (nothing else saved).</li>
 * </ul>
 */
public final class SaveTestHooks {
	private SaveTestHooks() {
	}

	static final String START_MARKER = "TEST-saving-off-at-start";

	private static volatile boolean failLedgerWrites;
	private static volatile @Nullable String noSaveInCreditSave;
	private static volatile java.util.@Nullable UUID depositBy;
	private static volatile @Nullable String depositSite;
	private static volatile @Nullable String rawSaveIn;
	private static volatile boolean haltAfter;
	/** (dev) what fired: counts and the deposit's moved units. */
	static volatile int startsOff, ledgerWritesFailed, creditSavesTurnedOff, deposits, depositMoved = -1, rawSaves;
	/** Set around /save-off's barrier (SaveHold.beforeSavingOff). */
	static volatile boolean inSavingOffBarrier;

	static void init() {
		ServerLevelEvents.LOAD.register((srv, level) -> {
			if (Files.exists(marker(srv))) {
				level.noSave = true;
				startsOff++;
				Architect.LOGGER.warn("Architect (TEST {}): {} loads with saving off", START_MARKER, level.dimension().identifier());
			}
		});
		ServerLifecycleEvents.SERVER_STARTED.register(srv -> {
			try {
				Files.deleteIfExists(marker(srv));
			} catch (IOException e) {
				Architect.LOGGER.warn("Architect (TEST): could not delete {} ({})", START_MARKER, e.getMessage());
			}
		});
		ServerLifecycleEvents.BEFORE_SAVE.register((srv, flush, force) -> beforeSave(srv));
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			failLedgerWrites = false;
			noSaveInCreditSave = null;
			depositBy = null;
			rawSaveIn = null;
			haltAfter = false;
		});
	}

	private static Path marker(MinecraftServer srv) {
		return srv.getWorldPath(LevelResource.ROOT).resolve("architect").resolve(START_MARKER);
	}

	/** (dev.stockpile.ps) Arms the hooks named in {@code req}. */
	static void arm(MinecraftServer srv, ServerPlayer player, JsonObject req) {
		if (req.has("savingOffAtStart") && req.get("savingOffAtStart").getAsBoolean()) {
			try {
				Files.createDirectories(marker(srv).getParent());
				Files.writeString(marker(srv), "TEST: every level starts with saving off\n");
			} catch (IOException e) {
				throw new java.io.UncheckedIOException(e);
			}
		}
		if (req.has("failLedgerWrites") && req.get("failLedgerWrites").getAsJsonPrimitive().isBoolean()) {
			failLedgerWrites = req.get("failLedgerWrites").getAsBoolean(); // (T4 merge) a count is T2b's (DurableFile.FAIL_BEFORE_RENAME)
		}
		if (req.has("noSaveInCreditSave")) {
			noSaveInCreditSave = req.get("noSaveInCreditSave").isJsonNull() ? null : req.get("noSaveInCreditSave").getAsString();
		}
		if (req.has("depositInSavingOffBarrier")) {
			depositBy = player.getUUID();
			depositSite = req.get("depositInSavingOffBarrier").getAsString();
			depositMoved = -1;
		}
		if (req.has("markUnsaved") && req.get("markUnsaved").getAsBoolean()) {
			Stockpiles.unsaved = true; // (TEST) a pending ledger change: /save-off's barrier runs
		}
		if (req.has("setAutoSaveOff") && req.get("setAutoSaveOff").getAsBoolean()) {
			// (T4 final round, SOFF2 P2, TEST) another mod's direct setAutoSave(false) (no /save-off command): its barrier may refuse it
			autoSaveOffAnswer = srv.setAutoSave(false);
		}
		if (req.has("rawSaveIn")) {
			rawSaveIn = req.get("rawSaveIn").isJsonNull() ? null : req.get("rawSaveIn").getAsString();
			haltAfter = req.has("haltAfter") && req.get("haltAfter").getAsBoolean();
		}
	}

	/** (TEST setAutoSaveOff) what the last direct setAutoSave(false) answered. */
	static volatile boolean autoSaveOffAnswer;

	static JsonObject json() {
		JsonObject o = new JsonObject();
		o.addProperty("autoSaveOffAnswer", autoSaveOffAnswer);
		o.addProperty("startsOff", startsOff);
		o.addProperty("failLedgerWrites", failLedgerWrites);
		o.addProperty("ledgerWritesFailed", ledgerWritesFailed);
		o.addProperty("noSaveInCreditSave", noSaveInCreditSave);
		o.addProperty("creditSavesTurnedOff", creditSavesTurnedOff);
		o.addProperty("deposits", deposits);
		o.addProperty("depositMoved", depositMoved);
		o.addProperty("rawSaveIn", rawSaveIn);
		o.addProperty("rawSaves", rawSaves);
		MinecraftServer srv = Stockpiles.SERVER;
		com.google.gson.JsonArray off = new com.google.gson.JsonArray();
		if (srv != null) {
			Stockpiles.levelsSavingOff(srv).forEach(off::add);
		}
		o.add("levelsOff", off); // (SOFF2 fix round) the levels with saving off now
		return o;
	}

	/** (Stockpiles.save) Whether this ledger write fails (TEST failLedgerWrites). */
	static boolean failLedgerWrite() {
		if (!failLedgerWrites) {
			return false;
		}
		ledgerWritesFailed++;
		if (ledgerWritesFailed <= 3 || ledgerWritesFailed % 100 == 0) {
			Architect.LOGGER.error("Stockpiles (TEST failLedgerWrites): the ledger write fails (#{})", ledgerWritesFailed);
		}
		return true;
	}

	private static void beforeSave(MinecraftServer srv) {
		String dim = noSaveInCreditSave;
		// (T4 merge) a removal txn's refund barrier is a stockpile road's credit save since T4b (no C29 saveCredit): the hook fires there too
		if (dim != null && (Stockpiles.inCreditSave() || CrateSettle.refundPublishing())) {
			noSaveInCreditSave = null;
			for (ServerLevel l : srv.getAllLevels()) {
				if (l.dimension().identifier().toString().equals(dim)) {
					l.noSave = true;
					creditSavesTurnedOff++;
					Architect.LOGGER.warn("Architect (TEST noSaveInCreditSave): {}'s saving turned off inside a credit's save", dim);
				}
			}
		}
		java.util.UUID by = depositBy;
		if (by != null && inSavingOffBarrier) {
			depositBy = null;
			ServerPlayer p = srv.getPlayerList().getPlayer(by);
			int moved = 0;
			if (p != null) {
				try {
					moved = Builder.insertFromInventory(p, depositSite);
				} catch (Sites.SiteException e) {
					Architect.LOGGER.warn("Architect (TEST depositInSavingOffBarrier): refused: {}", e.getMessage());
				}
			}
			deposits++;
			depositMoved = moved;
			Architect.LOGGER.warn("Architect (TEST depositInSavingOffBarrier): an Insert from inventory inside /save-off's barrier moved {}", moved);
		}
		if ("beforeSave".equals(rawSaveIn)) {
			rawSaveIn = null;
			raw(srv, "BEFORE_SAVE");
		}
	}

	/** (SaveTestPlayerListMixin) PlayerList.saveAll's head: the players not yet written. */
	public static void playersSaving(@Nullable MinecraftServer srv) {
		if (srv != null && "playerSave".equals(rawSaveIn)) {
			rawSaveIn = null;
			raw(srv, "a player save");
		}
	}

	private static void raw(MinecraftServer srv, String where) {
		rawSaves++;
		Architect.LOGGER.warn("Architect (TEST rawSaveIn): another mod's saveAllChunks(true, true, true) inside {}", where);
		srv.saveAllChunks(true, true, true);
		if (haltAfter) {
			Architect.LOGGER.error("Architect (TEST rawSaveIn haltAfter): halting the JVM (nothing else saved)");
			Runtime.getRuntime().halt(7);
		}
	}
}
