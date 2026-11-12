package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.FitMode;
import dev.larattalabs.architect.api.RegionRefused;
import dev.larattalabs.architect.api.SiteFrame;
import dev.larattalabs.architect.api.SitePort;
import dev.larattalabs.architect.api.SiteSpec;
import dev.larattalabs.architect.api.Volume;
import dev.larattalabs.architect.library.LibraryCard;
import dev.larattalabs.architect.library.LibraryMeta;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.TerrainFit;
import dev.larattalabs.architect.site.SiteFit;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/**
 * Phase 7b slice ST (docs/CONTRACT.md "Phase 7b" §3 row 8): the "opens onto a drop" warning ({@link SiteFit#drops}), the pin badge
 * ({@link LibraryCard#pinnedFit}, N-7b-6) and the helper's standalone answer ({@link SiteAnalysis#standaloneOf}).
 */
class ApiSTTest {
	static final BoundingBox VOL = new BoundingBox(-8, 56, -8, 23, 87, 19);
	static final String SHA = "a".repeat(64);

	/** A cliff-house-like site: lot 16 x 16 x 12 at (0, 64, 0), one walk port at design (7, 10, 1) facing north. */
	static SiteSpec site(Rotation r, Direction facing, String lotId) {
		return new SiteSpec(SHA, "b1", VOL, FitMode.ATTACH_TO_CLIFF, new SiteFrame(new BlockPos(0, 64, 0), r), List.of(), List.of(new SitePort("walk_top",
			SitePort.WALK, new BlockPos(7, 10, 1), facing, 2, 2, null)), lotId);
	}

	/** Ground (solid) at and below {@code groundY}, air above. */
	static TerrainFit.World ground(int groundY) {
		return (x, y, z) -> y <= groundY ? TerrainFit.NATURAL : TerrainFit.FILLABLE;
	}

	@Test
	void dropWarnsOnlyWhenTheCellOutsideThePortHasNoGround() {
		// the port's feet row is 74; ground at 73 under the cell outside it: standable, no warning
		assertEquals(List.of(), SiteFit.drops(site(Rotation.NONE, Direction.NORTH, null), 16, 12, ground(73)));
		// ground 3 lower: a drop
		List<String> w = SiteFit.drops(site(Rotation.NONE, Direction.NORTH, null), 16, 12, ground(70));
		assertEquals(1, w.size());
		assertTrue(w.get(0).startsWith(SiteFit.DROP + ": port walk_top faces north at 7,74,0"), w.get(0));
		// water in the cell: not standable
		TerrainFit.World wet = (x, y, z) -> y <= 73 ? TerrainFit.NATURAL : y == 74 ? TerrainFit.FILLABLE | TerrainFit.WATER : TerrainFit.FILLABLE;
		assertEquals(1, SiteFit.drops(site(Rotation.NONE, Direction.NORTH, null), 16, 12, wet).size());
		// no headroom (a solid cell above the feet): not standable either
		TerrainFit.World low = (x, y, z) -> y <= 73 || y == 75 ? TerrainFit.NATURAL : TerrainFit.FILLABLE;
		assertEquals(1, SiteFit.drops(site(Rotation.NONE, Direction.NORTH, null), 16, 12, low).size());
	}

	@Test
	void dropTurnsWithTheFrameAndSkipsLotsVerticalPortsAndPads() {
		// a quarter turn clockwise: design (7, 1) in a 16 x 12 template -> world (12 - 1 - 1, 7) = (10, 7); north turns to east -> (11, 74, 7)
		List<String> w = SiteFit.drops(site(Rotation.CLOCKWISE_90, Direction.NORTH, null), 16, 12, ground(70));
		assertEquals(1, w.size());
		assertTrue(w.get(0).contains("faces east at 11,74,7"), w.get(0));
		// under a lot the link pass joins the port: no warning
		assertEquals(List.of(), SiteFit.drops(site(Rotation.NONE, Direction.NORTH, "lot_a"), 16, 12, ground(0)));
		// a port facing down has no cell in front of it
		assertEquals(List.of(), SiteFit.drops(site(Rotation.NONE, Direction.DOWN, null), 16, 12, ground(0)));
		SiteSpec pad = new SiteSpec(SHA, "b1", VOL, FitMode.ON_PAD, new SiteFrame(new BlockPos(0, 64, 0), Rotation.NONE), List.of(), List.of(), null);
		assertEquals(List.of(), SiteFit.drops(pad, 16, 12, ground(0)));
	}

	static LibraryCard card(String extra) {
		JsonObject o = JsonParser.parseString("""
			{ "id": "h", "name": "House", "type": "house", "description": "d", "tags": [], "size": {"x": 16, "y": 16, "z": 12}, "source": "h.mjs" %s }
			""".formatted(extra)).getAsJsonObject();
		return LibraryCard.of(Blueprint.fromJson(o), o, LibraryMeta.NONE, false);
	}

	@Test
	void pinBadgeFromTheBindingOrTheSidecarSiteAndItWins() {
		String binding = ", \"ext\": {\"architect_mc:site\": {\"volumeSha\": \"" + SHA + "\", \"fit\": \"span\", \"volume\": " + SiteSpec.box(VOL) + "}}";
		LibraryCard bound = card(binding + ", \"variantOf\": \"x\"");
		assertEquals("span", bound.pinnedFit());
		assertTrue(bound.pinned());
		assertEquals(LibraryCard.PIN_BADGE, bound.badge(), "the pin wins over VARIANT");
		LibraryCard sidecar = card(", \"site\": " + site(Rotation.NONE, Direction.NORTH, null).wire());
		assertEquals("attach_to_cliff", sidecar.pinnedFit());
		assertEquals("PINNED", sidecar.badge());
		LibraryCard plain = card(", \"variantOf\": \"x\"");
		assertNull(plain.pinnedFit());
		assertFalse(plain.pinned());
		assertEquals("VARIANT", plain.badge());
		assertNull(card(", \"site\": {\"fit\": \"hover\"}").pinnedFit(), "a malformed site is not a pin");
	}

	static Volume volume() {
		return new Volume(SHA, VOL, "b7", Map.of(), 0, new Volume.Stats(0, 0, 0, 0, 0, 0));
	}

	static JsonObject ack(String standalone) {
		return JsonParser.parseString("{\"ok\": true, \"result\": {\"sha\": \"" + SHA + "\", \"box\": " + SiteSpec.box(VOL) + ", \"affordances\": [], "
			+ "\"proposed\": null" + (standalone == null ? "" : ", \"standalone\": " + standalone) + "}}").getAsJsonObject();
	}

	@Test
	void standaloneAnswerReadsTheSpecWithTheUploadedBlobOrTheReason() {
		JsonObject w = site(Rotation.NONE, Direction.NORTH, null).wire();
		w.addProperty("volumeBlobId", "local:" + SHA);
		SiteAnalysis.Standalone ok = SiteAnalysis.standaloneOf(volume(), ack("{\"ok\": true, \"affordance\": \"cliff_face_1\", \"spec\": " + w + "}"));
		assertNull(ok.reason());
		assertEquals("b7", ok.spec().volumeBlobId(), "the uploaded volume's blob, not the kit's local id");
		assertEquals(FitMode.ATTACH_TO_CLIFF, ok.spec().fit());
		assertNull(ok.spec().lotId());
		assertEquals(1, ok.spec().ports().size());
		SiteAnalysis.Standalone no = SiteAnalysis.standaloneOf(volume(), ack("{\"ok\": false, \"reason\": \"no cliff face at the plot\"}"));
		assertNull(no.spec());
		assertEquals("no cliff face at the plot", no.reason());
		SiteAnalysis.Standalone old = SiteAnalysis.standaloneOf(volume(), ack(null));
		assertNull(old.spec());
		assertTrue(old.reason().contains("update it"));
		JsonObject other = w.deepCopy();
		other.addProperty("volumeSha", "b".repeat(64));
		assertThrows(RegionRefused.class, () -> SiteAnalysis.standaloneOf(volume(), ack("{\"ok\": true, \"spec\": " + other + "}")));
	}
}
