package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Base64;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (QL-b D'') A lot's ground (plan.json's lotGround) over the world now: each write where its condition passes on the cell as it then stands.
 * Steward's crop-farm-067: the pads' IF_NATURAL grass under the lot's floor row lands over the land's dirt (and over grass, a no-op), so the
 * template's dirt there is quoted billed either way; an IF_AIR_OR_FLUID write over dirt is not applied; no ground: the world as it is.
 */
class QuotesLotGroundQLBTest {
	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	/** CellCond's rules over the few blocks here (the unit registry binds no tags): dirt, grass and air natural; air for IF_AIR_OR_FLUID. */
	private static final Quotes.Cond COND = (c, s) -> switch (c) {
		case Packed.IF_AIR_OR_FLUID -> s.isAir();
		case Packed.IF_SOLID_NATURAL -> s.is(Blocks.DIRT) || s.is(Blocks.GRASS_BLOCK);
		default -> s.isAir() || s.is(Blocks.DIRT) || s.is(Blocks.GRASS_BLOCK);
	};

	private static JsonObject lg(String seqs, int[]... runs) {
		ByteBuffer b = ByteBuffer.allocate(runs.length * 20).order(ByteOrder.LITTLE_ENDIAN);
		for (int[] r : runs) {
			for (int v : r) {
				b.putInt(v);
			}
		}
		JsonObject o = new JsonObject();
		o.add("seqs", JsonParser.parseString(seqs));
		o.addProperty("runs", Base64.getEncoder().encodeToString(b.array()));
		return o;
	}

	@Test
	void naturalPadGrassLandsOverDirtAndGrass() {
		JsonObject g = lg("[[[\"minecraft:grass_block\",0]],[[\"minecraft:grass_block\",2]],[[\"minecraft:air\",0],[\"minecraft:farmland[moisture=7]\",3]]]",
			new int[] {1811, 71965, 64, 64, 0}, new int[] {1812, 71965, 64, 64, 1}, new int[] {1811, 71964, 65, 65, 2});
		Map<Long, BlockState> overDirt = Quotes.ground(g, (x, y, z) -> y <= 64 ? Blocks.DIRT.defaultBlockState() : Blocks.AIR.defaultBlockState(), COND);
		assertEquals(Blocks.GRASS_BLOCK.defaultBlockState(), overDirt.get(BlockPos.asLong(1811, 64, 71965)), "IF_NATURAL grass over dirt");
		assertTrue(!overDirt.containsKey(BlockPos.asLong(1812, 64, 71965)), "IF_AIR_OR_FLUID grass is not written over dirt");
		assertEquals(Packed.parse("minecraft:farmland[moisture=7]"), overDirt.get(BlockPos.asLong(1811, 65, 71964)), "a sequence in order");
		Map<Long, BlockState> overGrass = Quotes.ground(g, (x, y, z) -> y <= 64 ? Blocks.GRASS_BLOCK.defaultBlockState() : Blocks.AIR.defaultBlockState(), COND);
		assertTrue(!overGrass.containsKey(BlockPos.asLong(1811, 64, 71965)), "grass over grass changes nothing: the world's grass stands");
		// either way the cell holds grass when the lot is priced, so the template's dirt there is billed (FullBomTest's ground case)
		assertTrue(Quotes.ground(g, (x, y, z) -> null, COND).isEmpty(), "a cell not loaded is left to the world");
		assertTrue(Quotes.ground(new JsonObject(), (x, y, z) -> Blocks.DIRT.defaultBlockState(), COND).isEmpty());
	}
}
