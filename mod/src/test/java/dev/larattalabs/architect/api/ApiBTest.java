package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.region.IrStale;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/**
 * API 1.21.0 (docs/CONTRACT.md "Phase 6c slice B" §1): {@link Regions#brush} is a default that throws "needs Architect API 1.21.0",
 * {@link BrushRequest} defaults its shape and destruction, {@link RegionView} keeps its 1.14.0 constructor (brush null), PERMISSION is
 * appended after FORMAT, the {@code brushes} feature comes from a B helper, and {@code volume:blocks} is appended to the IR kinds.
 */
class ApiBTest {
	@org.junit.jupiter.api.BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	@Test
	void version() {
		assertTrue(IrStale.semverCompare(ArchitectApi.VERSION, "1.21.0") >= 0, ArchitectApi.VERSION);
		assertTrue(IrStale.semverCompare(IrStale.KIT_VERSION, "0.23.0") >= 0, IrStale.KIT_VERSION);
	}

	@Test
	void permissionAppended() {
		assertTrue(Reason.PERMISSION.ordinal() > Reason.FORMAT.ordinal());
		assertEquals(Reason.FORMAT.ordinal() + 1, Reason.PERMISSION.ordinal());
		assertEquals(List.of("SMOOTH", "ERODE", "MELT", "BLEND", "RAISE", "LOWER", "OVERLAY", "CAVE_CARVE"), java.util.Arrays.stream(BrushKind.values())
			.map(Enum::name).toList());
		assertEquals(List.of("NATURAL_ONLY", "PLAYER_BLOCKS"), java.util.Arrays.stream(Destruction.values()).map(Enum::name).toList());
	}

	@Test
	void requestDefaults() {
		BrushRequest r = new BrushRequest("gate:x", Level.OVERWORLD, BrushKind.RAISE, null, BlockPos.ZERO, 4, 2, null, null, null, null, 7);
		assertEquals(BrushShape.SPHERE, r.shape());
		assertEquals(Destruction.NATURAL_ONLY, r.destruction());
		assertEquals(1, Limits.BRUSH_RADIUS_MIN);
		assertEquals(32, Limits.BRUSH_RADIUS_MAX);
		assertEquals(1, Limits.BRUSH_STRENGTH_MIN);
		assertEquals(16, Limits.BRUSH_STRENGTH_MAX);
	}

	@Test
	void regionViewOldConstructor() {
		RegionView v = new RegionView("rg1", "p", "s", null, new JsonObject(), "g", new BoundingBox(0, 0, 0, 1, 1, 1), RegionState.PLACED, List.of(),
			List.of(), 0, Map.of(), null, null, List.of(), 0L);
		assertNull(v.brush());
		RegionView b = new RegionView("rg1", "p", "s", null, new JsonObject(), "g", new BoundingBox(0, 0, 0, 1, 1, 1), RegionState.PLACED, List.of(),
			List.of(), 0, Map.of(), null, null, List.of(), 0L, "RAISE");
		assertEquals("RAISE", b.brush());
	}

	@Test
	void brushDefaultThrows() throws Exception {
		assertTrue(Regions.class.getMethod("brush", BrushRequest.class).isDefault());
		Regions old = (Regions) Proxy.newProxyInstance(Regions.class.getClassLoader(), new Class<?>[] {Regions.class}, (p, m, a) -> {
			if (m.isDefault()) {
				return java.lang.reflect.InvocationHandler.invokeDefault(p, m, a);
			}
			throw new AssertionError(m.getName());
		});
		var e = assertThrows(UnsupportedOperationException.class, () -> old.brush(new BrushRequest("gate:x", Level.OVERWORLD, BrushKind.SMOOTH, null,
			BlockPos.ZERO, 4, 2, null, null, null, null, 0)));
		assertTrue(e.getMessage().contains("1.21.0"), e.getMessage());
	}

	@Test
	void brushesFeatureAndKind() {
		assertTrue(ApiRules.features(2, List.of("region.plan", "region.tiles", "region.brush")).contains("brushes"));
		assertTrue(!ApiRules.features(2, List.of("region.plan", "region.tiles")).contains("brushes"));
		// appended (rebase point); (6c H) fluid and volume:fluids are appended after it
		assertEquals(List.of("volume:blocks", "fluid", "volume:fluids"), IrStale.KINDS_FORMAT2.subList(IrStale.KINDS_FORMAT2.indexOf("volume:blocks"), IrStale.KINDS_FORMAT2.size()), "appended (rebase point)");
	}
}
