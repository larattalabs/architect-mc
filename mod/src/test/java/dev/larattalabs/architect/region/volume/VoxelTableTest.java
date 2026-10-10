package dev.larattalabs.architect.region.volume;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.VoxelClass;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import org.junit.jupiter.api.Test;

/** The Java and JS voxel class tables are equal (gate item 1): the enum order, and the bundled file equals the kit's. */
class VoxelTableTest {
	static final Path KIT = Path.of("../kit/voxel_classes.json");

	@Test
	void enumOrderEqualsTheKit() throws Exception {
		JsonObject o = JsonParser.parseString(Files.readString(KIT)).getAsJsonObject();
		java.util.List<String> kit = new java.util.ArrayList<>();
		o.getAsJsonArray("classes").forEach(e -> kit.add(e.getAsString()));
		assertEquals(kit, Arrays.stream(VoxelClass.values()).map(Enum::name).toList());
		// and kit/REGIONS.md's pinned ordinals
		assertEquals(0, VoxelClass.AIR.ordinal());
		assertEquals(11, VoxelClass.OWNED.ordinal());
		assertEquals(14, VoxelClass.MISSING.ordinal());
	}

	@Test
	void bundledCopyEqualsTheKit() throws Exception {
		byte[] bundled;
		try (InputStream in = VoxelTable.class.getResourceAsStream(VoxelTable.RESOURCE)) {
			bundled = in.readAllBytes();
		}
		assertArrayEquals(Files.readAllBytes(KIT), bundled);
	}

	@Test
	void lookups() {
		VoxelTable t = VoxelTable.get();
		assertEquals(VoxelClass.ROCK, t.of("minecraft:stone"));
		assertEquals(VoxelClass.AIR, t.of("minecraft:air"));
		assertEquals(VoxelClass.WATER, t.of("minecraft:water"));
		assertEquals(VoxelClass.PLAYER, t.of("minecraft:oak_planks"));
		assertEquals(VoxelClass.PLAYER, t.of("minecraft:cobblestone_wall"));
		for (VoxelClass c : new VoxelClass[] {VoxelClass.OWNED, VoxelClass.PLAYER, VoxelClass.BLOCK_ENTITY, VoxelClass.MISSING}) {
			// the table lists natural blocks only: the derived classes never come from it
			assertEquals(false, JsonParser.parseString(readKit()).getAsJsonObject().getAsJsonObject("blocks").entrySet().stream().anyMatch(e -> e
				.getValue().getAsString().equals(c.name())), c.name());
		}
	}

	static String readKit() {
		try {
			return Files.readString(KIT);
		} catch (java.io.IOException e) {
			throw new IllegalStateException(e);
		}
	}
}
