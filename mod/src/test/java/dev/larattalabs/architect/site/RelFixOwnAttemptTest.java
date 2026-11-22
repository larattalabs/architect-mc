package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Busy;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.txn.CargoTxn;
import dev.larattalabs.architect.txn.RemovalTxn;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnEnv;
import dev.larattalabs.architect.txn.TxnStore;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (REL-v0910 fix round, P1; row RELF-own-attempt) Ported from the release reviewer's {@code Rel0910PlannedExtractionProbe}. After a confirmed
 * P0, one refused {@code removal.pblocks} intent save leaves road r1's attempt {@code planned}, no txn open, its cell held. Red at 68d2b065:
 * the group removing r1 waits behind its own attempt ({@code RemovalAreas.admissionOf} names {@code pblocks:r1@5#1}), so its ticks never reach
 * the retry that would drive the attempt (the runtime resolver skips planned attempts): stranded until a restart. The rule now: a removal's own
 * targets' live attempts are its prerequisites, never its blockers (one self rule for a road's, a cascade's and a group's admission), and a
 * group drives them before anything else of its R1. Guards (green before and after): another group over r1's held cell is still refused by the
 * attempt, and r1's own open holder cargo still refuses its group (no own-cargo exemption: T4RDL-cargo-retry).
 */
class RelFixOwnAttemptTest {
	static final String DIM = "minecraft:overworld";
	static final String KEY = "pblocks:r1@5#1";

	@TempDir
	Path tmp;

	/** txn.json: refuses every intent while {@link #refuse}; counts the intent saves tried. */
	static final class Env implements TxnEnv {
		boolean refuse = true;
		int writes;

		@Override
		public TxnStore store() {
			return new TxnStore() {
				@Override
				public DurableFile.Outcome write(JsonObject o) {
					writes++;
					return refuse ? DurableFile.Outcome.REFUSED : DurableFile.Outcome.OK;
				}

				@Override
				public DurableFile.Outcome confirm() {
					return DurableFile.Outcome.OK;
				}

				@Override
				public boolean inDoubt() {
					return false;
				}
			};
		}

		@Override
		public Barrier barrier() {
			return Barrier.ok(List.of());
		}

		@Override
		public boolean satisfied(dev.larattalabs.architect.txn.Await a) {
			return true;
		}

		@Override
		public void kill(String s) {
		}

		@Override
		public boolean emit(TxnEntry t, String e, JsonObject p, boolean r) {
			return true;
		}

		@Override
		public long tick() {
			return 0;
		}

		@Override
		public long wall() {
			return 0;
		}
	}

	Env env;
	TxnCore core;
	JsonObject at;

	@BeforeEach
	void setUp() throws Exception {
		Stockpiles.loadFrom(Files.createDirectories(tmp.resolve("world")));
		OwnerRemovals.read(null, null);
		env = new Env();
		core = new TxnCore(env).register(RemovalTxn.PBLOCKS_KIND).register(T4RDLCargoRetryTest.cargo());
		core.load(null, null);
		TxnCore c = core;
		RemovalAreas.CORE = () -> c; // (TxnServer needs the game's attachments: the seams name the core)
		Extractions.CORE = () -> c;
		JsonArray roads = new JsonArray();
		roads.add(road("r1", 0).toJson());
		roads.add(road("r2", 1).toJson()); // another road over r1's held cell (1,65,1)
		Infras.load(roads);
		at = JsonParser.parseString("{\"key\":\"" + KEY + "\",\"dim\":\"" + DIM + "\",\"target\":\"r1\",\"state\":\"planned\",\"cells\":[{\"pos\":" + BlockPos
			.asLong(1, 65, 1) + ",\"block\":\"minecraft:sponge\",\"was\":\"{Name:\\\"minecraft:air\\\"}\",\"items\":{\"minecraft:sponge\":1},"
			+ "\"recipient\":\"p\"}]}").getAsJsonObject();
		JsonObject ats = new JsonObject();
		ats.add("1", at);
		JsonObject target = new JsonObject();
		target.addProperty("gen", 1);
		target.add("attempts", ats);
		JsonObject table = new JsonObject();
		table.add("r1@5", target);
		Extractions.read(table);
		assertTrue(Stockpiles.writeConfirmed(null).ok(), "fixture: P0 on disk");
	}

	@AfterEach
	void reset() {
		RemovalAreas.CORE = dev.larattalabs.architect.txn.TxnServer::core;
		Extractions.CORE = dev.larattalabs.architect.txn.TxnServer::core;
		Extractions.read(null);
		OwnerRemovals.read(null, null);
		Infras.load(new JsonArray());
	}

	static Infra road(String id, int x) {
		return new Infra(id, "road", "p", new JsonObject(), DIM, new Anchors.Bounds(x, 64, 0, x + 2, 66, 2), 5, null, false, new JsonObject());
	}

	static Groups.Removal group(String id, String member) {
		Groups.Removal g = new Groups.Removal(id, null, null, false);
		g.started = true;
		g.sites.add(member);
		return g;
	}

	/** The real refused intent: drive the planned attempt once with txn.json refusing (the reviewer's window). */
	void refusedWindow() throws Exception {
		Method drive = null;
		for (Method m : Extractions.class.getDeclaredMethods()) {
			if (m.getName().equals("drive")) {
				drive = m;
			}
		}
		assertNotNull(drive, "Extractions.drive");
		drive.setAccessible(true);
		Object[] args = drive.getParameterCount() == 4 ? new Object[] {null, null, "r1@5", at} : new Object[] {null, "r1@5", at};
		Object why = drive.invoke(null, args);
		System.out.println("ROW RELF-own-attempt: the drive: " + why + "; open txns " + core.open().size() + "; state " + at.get("state") + "; held "
			+ Extractions.holds().size());
		assertEquals("txn.json refused its intent", why, "fixture: the actual refused-intent window");
		assertTrue(core.open().isEmpty(), "fixture: no txn open");
		assertEquals("planned", at.get("state").getAsString(), "fixture: the attempt stays planned");
		assertEquals(1, Extractions.holds().size(), "fixture: its cell held");
	}

	static void tick(Groups.Removal g, int n) throws Exception {
		Method tick = Groups.class.getDeclaredMethod("tick", net.minecraft.server.MinecraftServer.class, Groups.Removal.class);
		tick.setAccessible(true);
		Field clock = Groups.class.getDeclaredField("tick");
		clock.setAccessible(true);
		for (int i = 0; i < n; i++) {
			clock.setLong(null, clock.getLong(null) + 20);
			tick.invoke(null, null, g);
		}
	}

	@Test
	void aGroupsOwnPlannedAttemptNeverBlocksItsRetryWhichDrivesIt() throws Exception {
		System.out.println("ROW RELF-own-attempt (unit)");
		refusedWindow();
		Groups.Removal g = group("g1", "r1");
		int[] resumed = {0};
		g.afterCargo = () -> resumed[0]++;
		RemovalAreas.Area blocker = RemovalAreas.admissionOf(g);
		System.out.println("ROW RELF-own-attempt: the group's admission: " + (blocker == null ? null : blocker.site() + " " + blocker.busyOrDefault()));
		assertTrue(blocker == null || !blocker.site().equals(KEY), "RELF-own-attempt: the group's own planned attempt is never its blocker (it named " + KEY
			+ ")");
		int before = env.writes;
		tick(g, 4);
		System.out.println("ROW RELF-own-attempt: after 4 group ticks: ticket " + g.ticket + ", admitWaited " + g.admitWaited + ", intent saves tried "
			+ (env.writes - before) + ", wait " + g.gtxWait + ", state " + at.get("state"));
		assertFalse(g.ticket, "RELF-own-attempt: the group takes no FIFO ticket behind its own attempt");
		assertEquals(0, g.admitWaited, "RELF-own-attempt: and its wait never counts towards WAITING_BEHIND");
		assertTrue(env.writes - before >= 1, "RELF-own-attempt: its retry drives the planned attempt (its intent save tried again)");
		assertEquals(0, resumed[0], "R1 goes no further while its own attempt is not kept");
		assertEquals(1, Extractions.holds().size(), "the attempt's cell stays held while it waits");
		// the transient I/O failure is gone: the group's next retry drives the attempt into its txn (its intent durable: open)
		env.refuse = false;
		try {
			tick(g, 1);
		} catch (java.lang.reflect.InvocationTargetException e) {
			System.out.println("ROW RELF-own-attempt: the drive past its intent (no world here): " + e.getCause());
		}
		System.out.println("ROW RELF-own-attempt: with txn.json writable again: state " + at.get("state") + ", open txns " + core.open().size());
		assertEquals("open", at.get("state").getAsString(), "RELF-own-attempt: the group's retry made the attempt's intent durable (open)");
		assertEquals(1, core.open().size(), "RELF-own-attempt: its removal.pblocks txn is open (driven, resolved once it retires)");
	}

	@Test
	void anotherGroupOverTheHeldCellIsStillRefusedByTheAttempt() throws Exception {
		refusedWindow();
		RemovalAreas.Area a = RemovalAreas.admissionOf(group("g2", "r2"));
		System.out.println("ROW RELF-own-attempt guard: another group's admission: " + (a == null ? null : a.site()));
		assertNotNull(a, "guard: another group over r1's held cell waits");
		assertEquals(KEY, a.site(), "guard: behind r1's attempt");
		assertEquals(Busy.Kind.PLAYER_BLOCKS_RETURNING, a.busyOrDefault().kind(), "guard: typed PLAYER_BLOCKS_RETURNING");
	}

	@Test
	void itsOwnOpenHolderCargoStillRefusesItsGroup() throws Exception {
		refusedWindow();
		env.refuse = false;
		TxnEntry cargo = core.begin(CargoTxn.KIND, Extractions.cargoPrefix("r1@5") + "100#7", List.of("cell:" + DIM + "@1,65,1"), "p").entry();
		core.plan(cargo, dev.larattalabs.architect.txn.Effect.of(CargoTxn.TAKE, dev.larattalabs.architect.txn.EffectClass.B).prepare());
		core.persist(cargo);
		assertEquals(1, core.open().size(), "fixture: r1's own holder cargo open");
		RemovalAreas.Area a = RemovalAreas.admissionOf(group("g1", "r1"));
		System.out.println("ROW RELF-own-attempt guard: with its own cargo open: " + (a == null ? null : a.busyOrDefault()));
		assertNotNull(a, "guard: no own-cargo exemption (T4RDL-cargo-retry)");
		assertEquals(Busy.Kind.OPERATION_IN_PROGRESS, a.busyOrDefault().kind(), "guard: its own cargo refuses it, a retry by time");
		assertNotNull(Extractions.ownCargo(core, "r1@5"), "guard: and run still waits for it before any take or P0");
	}
}
