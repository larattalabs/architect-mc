package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.BrushKind;
import dev.larattalabs.architect.api.BrushRequest;
import dev.larattalabs.architect.api.BrushShape;
import dev.larattalabs.architect.api.Destruction;
import dev.larattalabs.architect.api.Reason;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;
import org.junit.jupiter.api.Test;

/** 6c slice B: the stroke's field and permission rules, its params, its boxes (equal to the kit's) and the command's options. */
class BrushesTest {
	@org.junit.jupiter.api.BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	static BrushRequest req(String owner, int radius, int strength, Destruction d, UUID actor) {
		return new BrushRequest(owner, Level.OVERWORLD, BrushKind.RAISE, BrushShape.CYLINDER, new BlockPos(10, 64, -3), radius, strength, null, null, d, actor,
			5);
	}

	@Test
	void fieldRules() {
		assertNull(Brushes.refusal(req("gate:x", 8, 4, Destruction.NATURAL_ONLY, null), null, false));
		assertEquals(Reason.FIELD_LIMIT, Brushes.refusal(req(null, 8, 4, null, null), null, false).reason());
		assertEquals(Reason.FIELD_LIMIT, Brushes.refusal(req("noColon", 8, 4, null, null), null, false).reason());
		ArchitectRefused r = Brushes.refusal(req("gate:x", 33, 4, null, null), null, false);
		assertEquals(Reason.FIELD_LIMIT, r.reason());
		assertTrue(r.getMessage().startsWith("radius: 33"), r.getMessage());
		assertEquals(Reason.FIELD_LIMIT, Brushes.refusal(req("gate:x", 0, 4, null, null), null, false).reason());
		assertEquals(Reason.FIELD_LIMIT, Brushes.refusal(req("gate:x", 8, 17, null, null), null, false).reason());
		assertEquals(Reason.FIELD_LIMIT, Brushes.refusal(req("gate:x", 8, 0, null, null), null, false).reason());
		BrushRequest nether = new BrushRequest("gate:x", Level.NETHER, BrushKind.RAISE, null, BlockPos.ZERO, 4, 2, null, null, null, null, 0);
		assertEquals(Reason.NOT_ALLOWED, Brushes.refusal(nether, null, false).reason());
	}

	@Test
	void playerBlocksNeedsPermission() {
		// no actor, or an actor not online: PERMISSION; the console's command path passes
		ArchitectRefused a = Brushes.refusal(req("gate:x", 8, 4, Destruction.PLAYER_BLOCKS, null), null, false);
		assertEquals(Reason.PERMISSION, a.reason());
		ArchitectRefused b = Brushes.refusal(req("gate:x", 8, 4, Destruction.PLAYER_BLOCKS, UUID.randomUUID()), null, false);
		assertEquals(Reason.PERMISSION, b.reason());
		assertTrue(b.getMessage().contains("not online"), b.getMessage());
		assertNull(Brushes.refusal(req("architect:player", 8, 4, Destruction.PLAYER_BLOCKS, null), null, true));
	}

	@Test
	void paramsAndBoxes() {
		JsonObject p = Brushes.params(req("gate:x", 8, 4, Destruction.PLAYER_BLOCKS, null));
		assertEquals(JsonParser.parseString("{\"kind\":\"raise\",\"shape\":\"cylinder\",\"cx\":10,\"cy\":64,\"cz\":-3,\"radius\":8,\"strength\":4,"
			+ "\"destruction\":\"player_blocks\"}"), p);
		// the kit's brushBox/volumeBox (kit/test/brush-b.test.mjs pins the same numbers)
		assertArrayEquals(new int[] {-22, 268, -36, 42, 319, 28}, Brushes.brushBox(new BlockPos(10, 300, -4), 32, -64, 319));
		assertArrayEquals(new int[] {-24, 266, -38, 44, 319, 30}, Brushes.volumeBox(new BlockPos(10, 300, -4), 32, -64, 319));
		assertTrue(Brushes.needsVolume(BrushKind.MELT, null));
		assertTrue(Brushes.needsVolume(BrushKind.CAVE_CARVE, null));
		assertFalse(Brushes.needsVolume(BrushKind.RAISE, null));
		assertTrue(Brushes.needsVolume(BrushKind.OVERLAY, JsonParser.parseString("{\"all\":[{\"height\":[0,9]},{\"block\":[\"stone\"]}]}").getAsJsonObject()));
		assertFalse(Brushes.needsVolume(BrushKind.OVERLAY, JsonParser.parseString("{\"slope\":[0,2]}").getAsJsonObject()));
	}

	@Test
	void commandOptions() {
		BrushCommands.Options o = BrushCommands.options("cylinder mask {\"height\": [60, 70]} pattern {\"mix\": [{\"w\": 1, \"mat\": \"stone\"}]} player_blocks seed 9 at 1 2 3");
		assertEquals(BrushShape.CYLINDER, o.shape());
		assertEquals(Destruction.PLAYER_BLOCKS, o.destruction());
		assertEquals(9, o.seed());
		assertEquals(new BlockPos(1, 2, 3), o.at());
		assertEquals(JsonParser.parseString("{\"height\":[60,70]}"), o.mask().spec());
		assertEquals(BrushShape.SPHERE, BrushCommands.options("").shape());
		assertThrows(IllegalArgumentException.class, () -> BrushCommands.options("wobble"));
		assertThrows(IllegalArgumentException.class, () -> BrushCommands.options("mask {\"height\": [60, 70]"));
		assertThrows(ArchitectRefused.class, () -> BrushCommands.options("mask {\"height\": [70, 60]}"));
	}
}
