package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.Holder;
import net.minecraft.core.MappedRegistry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.tags.TagKey;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (6c close-out B; PLAN "Queued from slice S3": the kit's volume classes vs the mod's natural rule) The kit's write conditions per block
 * (kit/test/fixtures/natural/conds.json, kept current by kit/test/natural-drift.test.mjs: the virtual world's {@code natural} from its
 * voxel classes) against the mod's {@link CellCond#passes} over the same block's default state, for IF_NATURAL and IF_SOLID_NATURAL. A
 * unit test has no data pack, so the vanilla block tags the mod's rule reads come with the fixture and are bound first (then bound empty
 * again: other tests see no tags, as before). A disagreement is a write the plan's virtual world makes and the realise skips (or the
 * reverse): S3's glacier route was one (generated ice, fixed in S3). {@link #EXCEPTIONS} names each kept difference and why.
 */
class NaturalDriftTest {
	/** Kept differences, block id -> why (the kit's class and the mod's rule disagree on purpose). */
	static final Map<String, String> EXCEPTIONS;

	static {
		String solid = "IF_SOLID_NATURAL's solid differs: the mod reads BlockState.isSolid (legacy), the kit the collision class; its only writer, a carve's"
			+ " lining (program.mjs carve), lines solid ground under the column's floor, where this plant never stands";
		EXCEPTIONS = Map.of("minecraft:azalea", solid, "minecraft:flowering_azalea", solid, "minecraft:chorus_flower", solid, "minecraft:cocoa", solid,
			"minecraft:sea_pickle", solid, "minecraft:bamboo_sapling", solid, "minecraft:sculk_vein", solid,
			"minecraft:lava", "the coordinator's ruling (2026-10-22), no behaviour change: the mod never writes over lava (CellCond's natural: air,"
				+ " natural, water, trees) and a plan cell over lava is LAVA; the kit's NATURAL class drives survey reading and M20:natural fire reach,"
				+ " a different question from what the mod may overwrite");
	}

	static JsonObject fixture;

	@BeforeAll
	static void bind() throws Exception {
		Boot.boot();
		fixture = JsonParser.parseString(Files.readString(Path.of("../kit/test/fixtures/natural/conds.json"))).getAsJsonObject();
		Map<TagKey<Block>, List<Holder<Block>>> tags = new HashMap<>();
		for (var e : fixture.getAsJsonObject("tags").entrySet()) {
			List<Holder<Block>> hs = new ArrayList<>();
			for (JsonElement id : e.getValue().getAsJsonArray()) {
				BuiltInRegistries.BLOCK.get(Identifier.parse(id.getAsString())).ifPresent(hs::add);
			}
			tags.put(TagKey.create(Registries.BLOCK, Identifier.parse(e.getKey())), hs);
		}
		((MappedRegistry<Block>) BuiltInRegistries.BLOCK).prepareTagReload(new net.minecraft.tags.TagLoader.LoadResult<>(Registries.BLOCK, tags)).apply();
		// the fluid tags the rule reads (TerrainFit.flags: FluidTags.WATER, LAVA), as vanilla's data pack has them
		Map<TagKey<net.minecraft.world.level.material.Fluid>, List<Holder<net.minecraft.world.level.material.Fluid>>> fl = new HashMap<>();
		fl.put(net.minecraft.tags.FluidTags.WATER, List.of(BuiltInRegistries.FLUID.wrapAsHolder(net.minecraft.world.level.material.Fluids.WATER),
			BuiltInRegistries.FLUID.wrapAsHolder(net.minecraft.world.level.material.Fluids.FLOWING_WATER)));
		fl.put(net.minecraft.tags.FluidTags.LAVA, List.of(BuiltInRegistries.FLUID.wrapAsHolder(net.minecraft.world.level.material.Fluids.LAVA),
			BuiltInRegistries.FLUID.wrapAsHolder(net.minecraft.world.level.material.Fluids.FLOWING_LAVA)));
		((MappedRegistry<net.minecraft.world.level.material.Fluid>) BuiltInRegistries.FLUID).prepareTagReload(new net.minecraft.tags.TagLoader.LoadResult<>(
			Registries.FLUID, fl)).apply();
	}

	@AfterAll
	static void unbind() {
		((MappedRegistry<Block>) BuiltInRegistries.BLOCK).prepareTagReload(new net.minecraft.tags.TagLoader.LoadResult<>(Registries.BLOCK, Map.of())).apply();
		((MappedRegistry<net.minecraft.world.level.material.Fluid>) BuiltInRegistries.FLUID).prepareTagReload(new net.minecraft.tags.TagLoader.LoadResult<>(
			Registries.FLUID, Map.of())).apply();
	}

	@Test
	void theModsWriteConditionsAgreeWithTheKitsClasses() {
		Map<String, String> disagree = new TreeMap<>();
		int n = 0;
		int unknown = 0;
		for (JsonElement e : fixture.getAsJsonArray("blocks")) {
			JsonObject b = e.getAsJsonObject();
			String id = b.get("id").getAsString();
			if (!BuiltInRegistries.BLOCK.containsKey(Identifier.parse(id))) {
				unknown++;
				continue;
			}
			BlockState s = BuiltInRegistries.BLOCK.getValue(Identifier.parse(id)).defaultBlockState();
			boolean kit = b.get("natural").getAsBoolean();
			boolean kitSolid = b.get("solidNatural").getAsBoolean();
			boolean mod = CellCond.passes(Packed.IF_NATURAL, s, false);
			boolean modSolid = CellCond.passes(Packed.IF_SOLID_NATURAL, s, false);
			n++;
			if ((kit != mod || kitSolid != modSolid) && !EXCEPTIONS.containsKey(id)) {
				disagree.put(id, b.get("v").getAsString() + ": kit natural " + kit + "/solid " + kitSolid + ", mod " + mod + "/solid " + modSolid);
			}
		}
		System.out.println("natural drift: " + n + " blocks, " + unknown + " not in the registry, " + disagree.size() + " disagree");
		disagree.forEach((k, v) -> System.out.println("  " + k + " " + v));
		assertTrue(n > 1000, n + " blocks");
		assertEquals(0, unknown, "every kit block is a 26.3 block");
		assertEquals(Map.of(), disagree);
		for (String id : EXCEPTIONS.keySet()) {
			assertTrue(BuiltInRegistries.BLOCK.containsKey(Identifier.parse(id)), "exception " + id + " is a block");
		}
	}
}
