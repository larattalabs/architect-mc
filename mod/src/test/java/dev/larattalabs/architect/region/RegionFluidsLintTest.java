package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.Fluids;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The water lint's W5 against the mod's real drain (docs/FAST-CHECKS.md "4. Water lint", kit/lint/water.mjs drainCases): over the
 * generated cases, whose fluid levels are the kit's vanilla model's steady state and whose expectations are the kit's attribution ("what
 * this source fed", never read from the Java result):
 * <ul>
 * <li>{@link RegionFluids#breachTake} (IRR's breach sweep, c170b161) takes only flowing water this body alone fed: never a source, never
 * foreign water, never a cell foreign water feeds; and, with nothing foreign touching the flow, all of it (none left orphaned);</li>
 * <li>{@link RegionFluids#drain} (the H batch's stray pass, bcdc7097) restores the recorded cells exactly (a natural flowing cell's level
 * included) and never writes a player's water in the watch box.</li>
 * </ul>
 */
class RegionFluidsLintTest {
	static final Path CASES = Path.of("../kit/lint/fixtures/drain-cases.json");

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static long p(JsonElement e) {
		JsonArray a = e.getAsJsonArray();
		return BlockPos.asLong(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
	}

	static long[] ps(JsonArray a) {
		long[] out = new long[a.size()];
		for (int i = 0; i < a.size(); i++) {
			out[i] = p(a.get(i));
		}
		return out;
	}

	static String s(long k) {
		return BlockPos.getX(k) + "," + BlockPos.getY(k) + "," + BlockPos.getZ(k);
	}

	static List<JsonObject> cases(String kind) throws Exception {
		JsonObject root = JsonParser.parseString(Files.readString(CASES)).getAsJsonObject();
		List<JsonObject> out = new ArrayList<>();
		root.getAsJsonArray("cases").forEach(c -> {
			if (c.getAsJsonObject().get("kind").getAsString().equals(kind)) {
				out.add(c.getAsJsonObject());
			}
		});
		return out;
	}

	@Test
	void theBreachSweepTakesOnlyWhatThisSourceFed() throws Exception {
		List<JsonObject> cs = cases("breach");
		assertTrue(cs.size() >= 8, "the generated breach cases");
		List<String> bad = new ArrayList<>();
		for (JsonObject c : cs) {
			Long2ObjectOpenHashMap<RegionFluids.Wet> w = new Long2ObjectOpenHashMap<>();
			for (JsonElement e : c.getAsJsonArray("cells")) {
				JsonObject o = e.getAsJsonObject();
				w.put(p(o.get("at")), new RegionFluids.Wet(o.get("amount").getAsInt(), o.get("source").getAsBoolean(), o.get("liquid").getAsBoolean()));
			}
			JsonArray seedsJ = c.getAsJsonArray("seeds");
			List<long[]> seeds = List.of(ps(seedsJ.get(0).getAsJsonArray()), ps(seedsJ.get(1).getAsJsonArray()), ps(seedsJ.get(2).getAsJsonArray()));
			LongOpenHashSet own = new LongOpenHashSet(ps(c.getAsJsonArray("own")));
			LongOpenHashSet foreign = new LongOpenHashSet(ps(c.getAsJsonArray("foreign")));
			JsonArray b = c.getAsJsonArray("box");
			int[] box = {b.get(0).getAsInt(), b.get(1).getAsInt(), b.get(2).getAsInt(), b.get(3).getAsInt(), b.get(4).getAsInt(), b.get(5).getAsInt()};
			LongOpenHashSet take = RegionFluids.breachTake(seeds, own, foreign, box, w::get, RegionFluids.BREACH_MAX);
			LongOpenHashSet ownOnly = new LongOpenHashSet(ps(c.getAsJsonArray("ownOnly")));
			LongOpenHashSet may = new LongOpenHashSet(ps(c.getAsJsonArray("may")));
			LongOpenHashSet never = new LongOpenHashSet(ps(c.getAsJsonArray("never")));
			Set<String> wrong = new TreeSet<>();
			Set<String> sources = new TreeSet<>();
			for (long k : take) {
				if (never.contains(k) || !may.contains(k)) {
					wrong.add(s(k));
				}
				RegionFluids.Wet x = w.get(k);
				if (x != null && x.source()) {
					sources.add(s(k));
				}
			}
			if (!wrong.isEmpty() || !sources.isEmpty()) {
				bad.add(c.get("name").getAsString() + ": took " + wrong.size() + " cell(s) this body did not alone feed " + head(wrong) + ", " + sources.size()
					+ " source(s) " + head(sources));
			}
			if (c.get("complete").getAsBoolean()) {
				Set<String> left = new TreeSet<>();
				for (long k : ownOnly) {
					if (!take.contains(k)) {
						left.add(s(k));
					}
				}
				if (!left.isEmpty()) {
					bad.add(c.get("name").getAsString() + ": nothing foreign touches the flow, yet " + left.size() + " cell(s) of it are left (orphan water) " + head(left));
				}
			}
		}
		assertTrue(bad.isEmpty(), String.join("\n", bad));
	}

	static String head(Set<String> s) {
		return s.stream().limit(6).toList().toString();
	}

	static BlockState water(int amount, boolean source) {
		if (source) {
			return Blocks.WATER.defaultBlockState();
		}
		// a falling or flowing block state: level 8 falling, else 8 - amount
		return Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, amount >= 8 ? 8 : 8 - amount);
	}

	@Test
	void theStrayPassRestoresTheRecordAndKeepsAPlayersWater() throws Exception {
		List<JsonObject> cs = cases("strays");
		assertTrue(!cs.isEmpty());
		for (JsonObject c : cs) {
			Map<Long, BlockState> world = new HashMap<>();
			for (JsonElement e : c.getAsJsonArray("cells")) {
				JsonObject o = e.getAsJsonObject();
				world.put(p(o.get("at")), water(o.get("amount").getAsInt(), o.get("source").getAsBoolean()));
			}
			long[] watch = ps(c.getAsJsonArray("watch"));
			String[] watchBefore = new String[watch.length];
			for (int i = 0; i < watch.length; i++) {
				watchBefore[i] = c.getAsJsonArray("watchBefore").get(i).getAsString();
				world.put(watch[i], RegionFluids.parse(c.get("watchNow").getAsString())); // the body's flow raised a natural cell's level
			}
			long[] body = ps(c.getAsJsonArray("body"));
			String[] before = new String[body.length];
			for (int i = 0; i < body.length; i++) {
				before[i] = c.getAsJsonArray("before").get(i).getAsString();
			}
			long[] predicted = ps(c.getAsJsonArray("predicted"));
			Set<Long> written = new java.util.HashSet<>();
			UmtDrain.drain(new UmtDrain.Cells() {
				@Override
				public BlockState get(BlockPos q) {
					return world.getOrDefault(q.asLong(), Blocks.AIR.defaultBlockState());
				}

				@Override
				public void set(BlockPos q, BlockState st, int flags) {
					world.put(q.asLong(), st);
					written.add(q.asLong());
				}
			}, body, before, watch, watchBefore, predicted);
			String name = c.get("name").getAsString();
			for (int i = 0; i < watch.length; i++) {
				assertEquals(RegionFluids.parse(watchBefore[i]), world.get(watch[i]), name + ": a watched cell back to its recorded state, its level included");
			}
			for (int i = 0; i < body.length; i++) {
				assertEquals(RegionFluids.parse(before[i]), world.getOrDefault(body[i], Blocks.AIR.defaultBlockState()), name + ": the body's cells back");
			}
			for (long k : ps(c.getAsJsonArray("never"))) {
				assertTrue(!written.contains(k), name + ": the drain wrote the player's water at " + s(k));
				assertTrue(world.get(k) != null && world.get(k).getFluidState().is(Fluids.WATER) || world.get(k) != null && world.get(k).getFluidState().is(Fluids.FLOWING_WATER),
					name + ": the player's water stays at " + s(k));
			}
			for (long k : predicted) {
				BlockState now = world.getOrDefault(k, Blocks.AIR.defaultBlockState());
				assertTrue(now.getFluidState().isEmpty(), name + ": the body's predicted flow taken back at " + s(k) + " (" + now + ")");
			}
		}
	}
}
