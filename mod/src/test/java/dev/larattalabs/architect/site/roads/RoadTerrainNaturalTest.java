package dev.larattalabs.architect.site.roads;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.placement.TerrainFit;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.MappedRegistry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.Bootstrap;
import net.minecraft.tags.FluidTags;
import net.minecraft.tags.TagKey;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.Fluid;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (rs-survival item 14, PLAN "Queued from 6c close-out B") RoadTerrain's natural ground is {@link TerrainFit#natural}: untouched packed
 * ice (and land ice, blue ice, calcite...) is ground a road may cut, never a BUILT obstacle; ice over water stays WATER; farmland and
 * a player's blocks stay BUILT. The vanilla tags the rules read come from the kit's fixture (kit/test/fixtures/natural/conds.json), as in
 * NaturalDriftTest, bound for this class and unbound after.
 */
class RoadTerrainNaturalTest {
	static JsonObject fixture;

	@BeforeAll
	static void bind() throws Exception {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
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
		Map<TagKey<Fluid>, List<Holder<Fluid>>> fl = new HashMap<>();
		fl.put(FluidTags.WATER, List.of(BuiltInRegistries.FLUID.wrapAsHolder(Fluids.WATER), BuiltInRegistries.FLUID.wrapAsHolder(Fluids.FLOWING_WATER)));
		fl.put(FluidTags.LAVA, List.of(BuiltInRegistries.FLUID.wrapAsHolder(Fluids.LAVA), BuiltInRegistries.FLUID.wrapAsHolder(Fluids.FLOWING_LAVA)));
		((MappedRegistry<Fluid>) BuiltInRegistries.FLUID).prepareTagReload(new net.minecraft.tags.TagLoader.LoadResult<>(Registries.FLUID, fl)).apply();
	}

	@AfterAll
	static void unbind() {
		((MappedRegistry<Block>) BuiltInRegistries.BLOCK).prepareTagReload(new net.minecraft.tags.TagLoader.LoadResult<>(Registries.BLOCK, Map.of())).apply();
		((MappedRegistry<Fluid>) BuiltInRegistries.FLUID).prepareTagReload(new net.minecraft.tags.TagLoader.LoadResult<>(Registries.FLUID, Map.of())).apply();
	}

	/** A column at (0, y, 0): the given states from y = 0 up, air above and around. */
	static final class Column implements BlockGetter {
		final BlockState[] states;

		Column(BlockState... states) {
			this.states = states;
		}

		@Override
		public @Nullable BlockEntity getBlockEntity(BlockPos pos) {
			return null;
		}

		@Override
		public BlockState getBlockState(BlockPos pos) {
			return pos.getX() == 0 && pos.getZ() == 0 && pos.getY() >= 0 && pos.getY() < states.length ? states[pos.getY()] : Blocks.AIR.defaultBlockState();
		}

		@Override
		public FluidState getFluidState(BlockPos pos) {
			return getBlockState(pos).getFluidState();
		}

		@Override
		public int getHeight() {
			return 384;
		}

		@Override
		public int getMinY() {
			return -64;
		}
	}

	/** The kind of the top of {@code column}. */
	static int top(BlockState... column) {
		Column c = new Column(column);
		BlockPos p = new BlockPos(0, column.length - 1, 0);
		return RoadTerrain.kind(c, p, c.getBlockState(p));
	}

	static BlockState s(Block b) {
		return b.defaultBlockState();
	}

	@Test
	void landIceIsStoneGround() {
		// street_e's ground at 3750,151,-999: untouched packed ice on stone
		assertEquals(RoadPlan.STONE, top(s(Blocks.STONE), s(Blocks.PACKED_ICE)));
		assertEquals(RoadPlan.STONE, top(s(Blocks.STONE), s(Blocks.PACKED_ICE), s(Blocks.PACKED_ICE)));
		assertEquals(RoadPlan.STONE, top(s(Blocks.SNOW_BLOCK), s(Blocks.BLUE_ICE)));
		assertEquals(RoadPlan.STONE, top(s(Blocks.DIRT), s(Blocks.ICE)));
		assertEquals(RoadPlan.STONE, top(s(Blocks.CALCITE)));
	}

	@Test
	void iceOverWaterStaysWater() {
		assertEquals(RoadPlan.WATER, top(s(Blocks.WATER), s(Blocks.ICE)));
		assertEquals(RoadPlan.WATER, top(s(Blocks.WATER), s(Blocks.PACKED_ICE), s(Blocks.PACKED_ICE)));
	}

	@Test
	void builtStaysBuilt() {
		assertEquals(RoadPlan.BUILT, top(s(Blocks.DIRT), s(Blocks.FARMLAND)), "a player's field");
		assertEquals(RoadPlan.BUILT, top(s(Blocks.STONE_BRICKS)));
		assertEquals(RoadPlan.BUILT, top(s(Blocks.OAK_PLANKS)));
		assertEquals(RoadPlan.BUILT, top(s(Blocks.SNOW_BLOCK), s(Blocks.BRICKS)), "bricks on snow are built");
	}

	@Test
	void everyNaturalBlockIsGroundOrOpenNeverBuilt() {
		Map<String, String> built = new TreeMap<>();
		int n = 0;
		for (JsonElement e : fixture.getAsJsonArray("blocks")) {
			Identifier id = Identifier.parse(e.getAsJsonObject().get("id").getAsString());
			if (!BuiltInRegistries.BLOCK.containsKey(id)) {
				continue;
			}
			BlockState st = BuiltInRegistries.BLOCK.getValue(id).defaultBlockState();
			if (!(TerrainFit.natural(st) || dev.larattalabs.architect.region.CellCond.alsoNatural(st)) || st.is(Blocks.FARMLAND)) {
				continue;
			}
			n++;
			int k = top(s(Blocks.STONE), st);
			if (k == RoadPlan.BUILT || k == RoadPlan.BUILT_OPEN) {
				built.put(id.toString(), k == RoadPlan.BUILT ? "BUILT" : "BUILT_OPEN");
			}
		}
		assertTrue(n > 50, n + " natural blocks");
		assertEquals(Map.of(), built, "natural blocks RoadTerrain calls built");
	}
}
