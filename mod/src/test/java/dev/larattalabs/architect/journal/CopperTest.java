package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.minecraft.SharedConstants;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.resources.Identifier;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.Half;
import net.minecraft.world.level.block.state.properties.SlabType;
import net.minecraft.world.level.block.state.properties.StairsShape;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (6c CU §8 item 2) The copper chain and "still ours": {@link Copper#canonical} read from vanilla's maps equals what kit/lib/blocks.mjs's
 * {@code wx} table (the kit's own dump of the same maps) says for all 60 rows and their 60 waxed twins; every stage, waxed and scraped
 * state holds against the stage written; another form never does; facing and half still compare; the copper chest's empty-container
 * rule; farmland and dirt (S-CU-3); {@link WorldJournal#same}; the block test the builder and the refund use ({@link Copper#is}).
 */
class CopperTest {
	static final Path BLOCKS = Path.of("../kit/lib/blocks.mjs");
	static final Pattern ROW = Pattern.compile("^v\\('([a-z0-9_]+)', \\{[^\\n]*?wx: \\{([^}]*)\\}", Pattern.MULTILINE);
	static final Pattern KV = Pattern.compile("(next|waxed): '([a-z0-9_]+)'");

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static Block block(String id) {
		Identifier k = Identifier.parse("minecraft:" + id);
		assertTrue(BuiltInRegistries.BLOCK.containsKey(k), "no block " + id);
		return BuiltInRegistries.BLOCK.getValue(k);
	}

	static BlockState st(String id) {
		return block(id).defaultBlockState();
	}

	/** The kit's wx rows: id -> {next, waxed} (next null on the last stage). */
	static Map<String, String[]> kitRows() throws IOException {
		String src = Files.readString(BLOCKS);
		Map<String, String[]> out = new TreeMap<>();
		Matcher m = ROW.matcher(src);
		while (m.find()) {
			String next = null, waxed = null;
			Matcher kv = KV.matcher(m.group(2));
			while (kv.find()) {
				if (kv.group(1).equals("next")) {
					next = kv.group(2);
				} else {
					waxed = kv.group(2);
				}
			}
			out.put(m.group(1), new String[] {next, waxed});
		}
		return out;
	}

	@Test
	void canonicalEqualsTheKitsTable() throws IOException {
		Map<String, String[]> rows = kitRows();
		assertEquals(60, rows.size(), "kit/lib/blocks.mjs's wx rows: 15 forms x 4 stages");
		// the kit's chains: a row nobody's next is a first stage; walk back from each row to its first
		Map<String, String> prev = new HashMap<>();
		rows.forEach((id, r) -> {
			if (r[0] != null) {
				prev.put(r[0], id);
			}
		});
		Set<String> firsts = new TreeSet<>();
		Set<String> kitChain = new TreeSet<>();
		for (var e : rows.entrySet()) {
			String first = e.getKey();
			while (prev.containsKey(first)) {
				first = prev.get(first);
			}
			firsts.add(first);
			assertNotNull(e.getValue()[1], e.getKey() + ": every stage is waxable");
			assertSame(block(first), Copper.canonical(block(e.getKey())), e.getKey() + " -> " + first);
			assertSame(block(first), Copper.canonical(block(e.getValue()[1])), e.getValue()[1] + " -> " + first);
			kitChain.add(e.getKey());
			kitChain.add(e.getValue()[1]);
		}
		assertEquals(15, firsts.size(), "15 forms: " + firsts);
		assertEquals(120, kitChain.size());
		// and vanilla has no copper block the kit's table misses (or the other way round)
		Set<String> java = new TreeSet<>();
		for (Block b : BuiltInRegistries.BLOCK) {
			if (Copper.inChain(b)) {
				java.add(BuiltInRegistries.BLOCK.getKey(b).getPath());
			}
		}
		assertEquals(kitChain, java);
		// outside the chain: itself, never in it
		for (Block b : new Block[] {block("copper_ore"), block("raw_copper_block"), block("deepslate_copper_ore"), Blocks.STONE}) {
			assertSame(b, Copper.canonical(b));
			assertFalse(Copper.inChain(b), b.toString());
		}
	}

	@Test
	void everyStageWaxedAndScrapedHolds() throws IOException {
		for (var e : kitRows().entrySet()) {
			Block stage = block(e.getKey());
			Block waxed = block(e.getValue()[1]);
			Block first = Copper.canonical(stage);
			for (Block wrote : new Block[] {first, stage, waxed}) {
				for (Block now : new Block[] {first, stage, waxed}) {
					BlockState n = now.withPropertiesOf(wrote.defaultBlockState());
					assertTrue(StillOurs.holds(n, null, wrote.defaultBlockState(), null), now + " holds " + wrote);
					assertTrue(Copper.is(n, wrote), now + " is " + wrote);
					assertTrue(WorldJournal.same(WorldJournal.value(n), WorldJournal.value(wrote.defaultBlockState())), "same: " + now + " / " + wrote);
				}
			}
		}
	}

	@Test
	void anotherFormNeverHolds() {
		BlockState stairs = st("cut_copper_stairs");
		BlockState slab = st("cut_copper_slab");
		assertFalse(StillOurs.holds(st("exposed_cut_copper_slab"), null, stairs, null), "cut stairs against cut slab");
		assertFalse(StillOurs.holds(st("waxed_oxidized_cut_copper_stairs"), null, slab, null));
		assertFalse(StillOurs.holds(st("oxidized_copper"), null, st("cut_copper"), null));
		assertFalse(StillOurs.holds(st("waxed_copper_block"), null, st("chiseled_copper"), null));
		assertFalse(Copper.is(st("exposed_copper_grate"), block("copper_block")));
		assertFalse(Copper.sameBlock(block("copper_ore"), block("copper_block")));
		assertFalse(StillOurs.holds(Blocks.STONE.defaultBlockState(), null, st("copper_block"), null));
		assertFalse(StillOurs.holds(Blocks.AIR.defaultBlockState(), null, st("oxidized_copper"), null), "mined: not ours");
	}

	@Test
	void facingAndHalfStillCompare() {
		BlockState wrote = st("cut_copper_stairs").setValue(StairBlock.FACING, Direction.NORTH).setValue(StairBlock.HALF, Half.BOTTOM);
		BlockState w = block("weathered_cut_copper_stairs").withPropertiesOf(wrote);
		assertTrue(StillOurs.holds(w, null, wrote, null));
		assertTrue(StillOurs.holds(w.setValue(StairBlock.SHAPE, StairsShape.OUTER_LEFT).setValue(StairBlock.WATERLOGGED, true), null, wrote, null), "shape and waterlogged are volatile");
		assertFalse(StillOurs.holds(w.setValue(StairBlock.FACING, Direction.SOUTH), null, wrote, null), "facing compares");
		assertFalse(StillOurs.holds(w.setValue(StairBlock.HALF, Half.TOP), null, wrote, null), "half compares");
		BlockState slab = st("cut_copper_slab").setValue(BlockStateProperties.SLAB_TYPE, SlabType.BOTTOM);
		assertFalse(StillOurs.holds(block("waxed_cut_copper_slab").withPropertiesOf(slab).setValue(BlockStateProperties.SLAB_TYPE, SlabType.TOP), null, slab, null), "type compares");
		BlockState bulb = st("copper_bulb");
		assertTrue(StillOurs.holds(block("oxidized_copper_bulb").withPropertiesOf(bulb).setValue(BlockStateProperties.LIT, true), null, bulb, null), "lit is volatile");
		BlockState door = st("copper_door");
		assertTrue(StillOurs.holds(block("waxed_exposed_copper_door").withPropertiesOf(door).setValue(BlockStateProperties.OPEN, true), null, door, null), "open is volatile");
		assertFalse(StillOurs.holds(block("waxed_exposed_copper_door").withPropertiesOf(door).setValue(BlockStateProperties.DOUBLE_BLOCK_HALF,
			door.getValue(BlockStateProperties.DOUBLE_BLOCK_HALF) == net.minecraft.world.level.block.state.properties.DoubleBlockHalf.LOWER
				? net.minecraft.world.level.block.state.properties.DoubleBlockHalf.UPPER : net.minecraft.world.level.block.state.properties.DoubleBlockHalf.LOWER), null, door, null),
			"a door's half compares");
	}

	@Test
	void copperChestEmptyContainerRule() {
		BlockState chest = st("copper_chest");
		BlockState now = block("waxed_oxidized_copper_chest").withPropertiesOf(chest);
		assertTrue(chest.hasBlockEntity() && now.hasBlockEntity());
		CompoundTag empty = new CompoundTag();
		CompoundTag full = new CompoundTag();
		ListTag items = new ListTag();
		CompoundTag one = new CompoundTag();
		one.putString("id", "minecraft:copper_ingot");
		one.putInt("count", 3);
		items.add(one);
		full.put("Items", items);
		assertTrue(StillOurs.holds(now, empty, chest, null), "an empty chest we wrote, weathered and waxed, still empty");
		assertTrue(StillOurs.holds(now, null, chest, empty));
		assertFalse(StillOurs.holds(now, full, chest, empty), "a chest the player filled is not ours");
		assertTrue(StillOurs.holds(now, full, chest, full), "written full, still full");
		assertFalse(StillOurs.holds(st("copper_golem_statue"), null, chest, null), "a statue is not a chest");
		BlockState statue = st("copper_golem_statue");
		assertTrue(StillOurs.holds(block("waxed_weathered_copper_golem_statue").withPropertiesOf(statue), null, statue, null));
	}

	@Test
	void farmlandAndDirt() {
		BlockState farm = Blocks.FARMLAND.defaultBlockState();
		BlockState dirt = Blocks.DIRT.defaultBlockState();
		assertTrue(StillOurs.holds(dirt, null, farm, null), "farmland dried or trampled to dirt: ours (S-CU-3)");
		assertTrue(StillOurs.holds(farm, null, dirt, null), "dirt tilled: ours");
		assertTrue(StillOurs.holds(farm.setValue(BlockStateProperties.MOISTURE, 7), null, farm, null), "moisture is volatile");
		assertTrue(StillOurs.holds(Blocks.GRASS_BLOCK.defaultBlockState(), null, dirt, null), "grass and dirt, as before");
		assertFalse(StillOurs.holds(Blocks.STONE.defaultBlockState(), null, farm, null));
		assertFalse(StillOurs.holds(Blocks.AIR.defaultBlockState(), null, farm, null));
		// the other drift kinds stay as before (§5, N-CU-1): a decayed leaf, a grown sapling, melted snow are not ours
		assertFalse(StillOurs.holds(Blocks.AIR.defaultBlockState(), null, Blocks.OAK_LEAVES.defaultBlockState(), null));
		assertFalse(StillOurs.holds(Blocks.OAK_LOG.defaultBlockState(), null, Blocks.OAK_SAPLING.defaultBlockState(), null));
		assertFalse(StillOurs.holds(Blocks.AIR.defaultBlockState(), null, Blocks.SNOW.defaultBlockState(), null));
	}

	@Test
	void builderAndRefundBlockTest() {
		// Builder.Run.matches, RoadBuilder.refundOf (through it) and Sites.evidence compare by block through Copper.is
		assertTrue(Copper.is(st("waxed_weathered_cut_copper"), block("cut_copper")));
		assertTrue(Copper.is(st("cut_copper"), block("oxidized_cut_copper")));
		assertTrue(Copper.is(Blocks.OAK_DOOR.defaultBlockState().setValue(BlockStateProperties.OPEN, true), Blocks.OAK_DOOR), "not copper: the block itself");
		assertFalse(Copper.is(st("cut_copper"), block("cut_copper_slab")));
		assertFalse(Copper.is(Blocks.DIRT.defaultBlockState(), Blocks.FARMLAND), "the builder's test is copper only");
	}
}
