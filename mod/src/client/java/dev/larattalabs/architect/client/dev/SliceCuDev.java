package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.HoneycombItem;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.WeatheringCopper;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;

/**
 * Phase 6c slice CU DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT CU §8 items 3-8): what a player's honeycomb or axe does to a copper
 * block in place (vanilla's own maps: HoneycombItem.getWaxed; an axe takes the wax off, else scrapes one stage back), and one weathering
 * step (WeatheringCopper.getNext) for a cell random ticks were too slow for. No player placement is recorded (the block is still the one
 * that stood). A door's other half follows. Server work only (the headless server generates them too: devserver genHooks).
 */
public final class SliceCuDev {
	private SliceCuDev() {
	}

	public static void init() {
		DevBridge.register("dev.copper.use", 120_000, "{at?: [x,y,z], cells?: [[x,y,z]], item: honeycomb|axe|weather} - (6c CU) a honeycomb waxes, an "
			+ "axe unwaxes or scrapes one stage back, weather moves one stage on (vanilla's maps), each cell set in place with its other "
			+ "properties (a door's other half too) -> {cells: [{at, before, after, changed}]}", (req, mc) -> {
				String item = req.get("item").getAsString();
				List<BlockPos> at = new ArrayList<>();
				if (req.has("at")) {
					at.add(pos(req.getAsJsonArray("at")));
				}
				if (req.has("cells")) {
					for (JsonElement c : req.getAsJsonArray("cells")) {
						at.add(pos(c.getAsJsonArray()));
					}
				}
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonArray out = new JsonArray();
					for (BlockPos p : at) {
						out.add(use(level, p, item));
					}
					JsonObject o = new JsonObject();
					o.add("cells", out);
					return o;
				});
			});
	}

	static BlockPos pos(JsonArray a) {
		return new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
	}

	/** The state {@code item} turns {@code s} into, if any. */
	static Optional<BlockState> next(BlockState s, String item) {
		Block b = s.getBlock();
		return switch (item) {
			case "honeycomb" -> HoneycombItem.getWaxed(s);
			case "axe" -> {
				Block u = HoneycombItem.WAX_OFF_BY_BLOCK.get().get(b);
				yield u != null ? Optional.of(u.withPropertiesOf(s)) : WeatheringCopper.getPrevious(s);
			}
			case "weather" -> Optional.ofNullable(WeatheringCopper.NEXT_BY_BLOCK.get().get(b)).map(n -> n.withPropertiesOf(s));
			default -> throw new DevBridge.DevException("item: honeycomb, axe or weather (got " + item + ")");
		};
	}

	static JsonObject use(ServerLevel level, BlockPos p, String item) {
		BlockState s = level.getBlockState(p);
		JsonObject o = new JsonObject();
		JsonArray a = new JsonArray();
		a.add(p.getX());
		a.add(p.getY());
		a.add(p.getZ());
		o.add("at", a);
		o.addProperty("before", s.toString());
		Optional<BlockState> n = next(s, item);
		if (n.isPresent()) {
			BlockState to = n.get();
			// (no neighbour updates: a door's halves change together, as vanilla's own copper door does)
			level.setBlock(p, to, Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE);
			if (s.getBlock() instanceof DoorBlock && s.hasProperty(BlockStateProperties.DOUBLE_BLOCK_HALF)) {
				BlockPos q = s.getValue(BlockStateProperties.DOUBLE_BLOCK_HALF) == DoubleBlockHalf.LOWER ? p.above() : p.below();
				BlockState other = level.getBlockState(q);
				if (other.getBlock() == s.getBlock()) {
					level.setBlock(q, to.getBlock().withPropertiesOf(other), Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE);
				}
			}
		}
		BlockState after = level.getBlockState(p);
		o.addProperty("after", after.toString());
		o.addProperty("changed", after != s);
		return o;
	}
}
