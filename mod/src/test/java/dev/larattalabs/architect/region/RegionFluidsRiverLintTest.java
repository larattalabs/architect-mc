package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (8c WU, the Java half of CL's gate) The mod's drain over the kit's river cases ({@code kit/lint/fixtures/river-cases.json},
 * kit/lint/water.mjs riverCases): per case one river body (its sources the case's {@code own} and {@code lifted} cells), the world as
 * the case's settled levels ({@code now}: 0 a source, 1-7 flowing, 8+ falling; a {@code block} cell a waterlogged block, a foreign wl
 * source; a {@code volatile} cell no liquid), water there before the realise the {@code eflat} and {@code refed} cells (outside the watch
 * set). Then {@link RegionFluids#strayTake} (the stray pass's W5 attribution) must take exactly the cells the kit marks {@code take}
 * besides the sources (own stale flow and raised cells), never a {@code keep} one (joint, foreign, a block, a volatile cell, eflat or
 * refed water). The sources themselves are the drain's first step ({@link RegionFluids#drainSources}).
 */
class RegionFluidsRiverLintTest {
	static final Path CASES = Path.of("../kit/lint/fixtures/river-cases.json");

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static long p(JsonElement e) {
		JsonArray a = e.getAsJsonArray();
		return BlockPos.asLong(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
	}

	static String s(long k) {
		return BlockPos.getX(k) + "," + BlockPos.getY(k) + "," + BlockPos.getZ(k);
	}

	static String runs(List<Long> cells) {
		StringBuilder b = new StringBuilder("[");
		for (long c : cells) {
			if (b.length() > 1) {
				b.append(',');
			}
			b.append('[').append(BlockPos.getX(c)).append(',').append(BlockPos.getZ(c)).append(',').append(BlockPos.getY(c)).append(',').append(BlockPos.getY(c))
				.append(']');
		}
		return b.append(']').toString();
	}

	@Test
	void theStrayPassTakesWhatTheKitSaysOverEveryRiverCase() throws Exception {
		JsonArray cases = JsonParser.parseString(Files.readString(CASES)).getAsJsonObject().getAsJsonArray("cases");
		assertTrue(cases.size() >= 5, "CL's five river cases");
		int checked = 0;
		List<String> wrong = new ArrayList<>();
		for (JsonElement ce : cases) {
			JsonObject c = ce.getAsJsonObject();
			String name = c.get("name").getAsString();
			List<Long> own = new ArrayList<>();
			c.getAsJsonArray("own").forEach(e -> own.add(p(e)));
			c.getAsJsonArray("lifted").forEach(e -> own.add(p(e)));
			java.util.Map<Long, RegionFluids.Wet> world = new java.util.HashMap<>();
			StringBuilder pred = new StringBuilder("[");
			List<Long> before = new ArrayList<>();
			TreeSet<String> want = new TreeSet<>();
			java.util.Map<Long, Integer> afterOf = new java.util.HashMap<>();
			for (JsonElement xe : c.getAsJsonArray("cells")) {
				JsonObject x = xe.getAsJsonObject();
				long k = p(x.get("at"));
				String cls = x.get("class").getAsString();
				if ("block".equals(cls)) {
					world.put(k, new RegionFluids.Wet(8, true, false)); // a waterlogged block: a source, no liquid block
				} else if (x.get("now") instanceof JsonElement n && n.isJsonPrimitive() && n.getAsJsonPrimitive().isNumber()) {
					int lv = n.getAsInt();
					world.put(k, new RegionFluids.Wet(lv == 0 || lv >= 8 ? 8 : 8 - lv, lv == 0, true));
				}
				if ("eflat".equals(cls) || "refed".equals(cls)) {
					before.add(k);
				}
				if (("own".equals(cls) || "raised".equals(cls) || "joint".equals(cls)) && x.get("now") instanceof JsonElement n && n.isJsonPrimitive()) {
					if (pred.length() > 1) {
						pred.append(',');
					}
					pred.append('[').append(BlockPos.getX(k)).append(',').append(BlockPos.getY(k)).append(',').append(BlockPos.getZ(k)).append(',').append(Math.max(1, n
						.getAsInt())).append(']');
				}
				if ("take".equals(x.get("drain").getAsString()) && !"source".equals(cls)) {
					want.add(s(k));
					afterOf.put(k, x.get("after") instanceof JsonElement af && af.isJsonPrimitive() ? Integer.valueOf(af.getAsInt()) : null);
				}
			}
			for (long k : own) {
				world.put(k, new RegionFluids.Wet(8, true, true));
			}
			pred.append(']');
			String ir = "{\"parts\":[{\"id\":\"r_r1\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"r_r1\",\"part\":\"r\",\"fluid\":\"water\",\"level\":64,"
				+ "\"cells\":" + runs(own) + ",\"predicted\":" + pred + ",\"settleTicks\":200,\"flow\":\"current\"}]}]}";
			RegionFluids.Regional st = new RegionFluids.Regional(RegionFluids.bodiesOf(JsonParser.parseString(ir).getAsJsonObject()));
			st.states.get("r_r1").before.put(own.get(0), "minecraft:air");
			for (long k : before) {
				st.fluidBefore.put(k, "minecraft:water");
			}
			TreeSet<String> got = new TreeSet<>();
			java.util.List<long[]> take = RegionFluids.strayTake(st, world::get, k -> true);
			for (long[] t : take) {
				got.add(s(t[0]));
			}
			// ((8c fix round, P1-6) the resulting states, not just the selection: an own-only cell dry (its before), a raised cell at the
			// foreign-only level the kit's `after` names)
			for (long[] w : RegionFluids.strayWork(st, take, world::get)) {
				Integer after = afterOf.get(w[0]);
				int lv = w[2] <= 0 ? -1 : w[2] >= 8 ? 8 : 8 - (int) w[2];
				int exp = after == null ? -1 : after;
				if (lv != exp) {
					wrong.add(name + ": " + s(w[0]) + " restored to " + (lv < 0 ? "its before state" : "level " + lv) + ", the kit says " + (exp < 0 ? "dry" : "level " + exp));
				}
			}
			if (!got.equals(want)) {
				TreeSet<String> extra = new TreeSet<>(got);
				extra.removeAll(want);
				TreeSet<String> missing = new TreeSet<>(want);
				missing.removeAll(got);
				wrong.add(name + ": taken but kept by the kit " + extra + "; the kit's take not taken " + missing);
			}
			checked++;
		}
		assertEquals(cases.size(), checked);
		assertEquals(List.of(), wrong, "the stray pass agrees with CL's W5 over every river case");
	}

	@Test
	void refedIsTheWorldsOwnFlowingWaterRefed() {
		assertEquals(true, RegionHash.refed("minecraft:water[level=1]", "minecraft:water[level=5]", true));
		assertEquals(false, RegionHash.refed("minecraft:water[level=1]", "minecraft:water[level=5]", false), "nothing feeds it: not the world's");
		assertEquals(false, RegionHash.refed("minecraft:water", "minecraft:water[level=5]", true), "a source before is never refed");
		assertEquals(false, RegionHash.refed("minecraft:air", "minecraft:water[level=5]", true), "no water before: not refed");
		assertEquals(false, RegionHash.refed("minecraft:water[level=2]", "minecraft:lava[level=2]", true));
	}
}
