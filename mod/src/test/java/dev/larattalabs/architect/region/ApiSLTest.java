package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.FitMode;
import dev.larattalabs.architect.api.LotSpec;
import dev.larattalabs.architect.api.RegionPlan;
import dev.larattalabs.architect.api.SiteBinding;
import dev.larattalabs.architect.api.SiteSpec;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.region.volume.Arvx;
import dev.larattalabs.architect.region.volume.VolumeSurvey;
import dev.larattalabs.architect.site.SiteFit;
import dev.larattalabs.architect.site.SiteLots;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import net.minecraft.world.level.block.Rotation;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Since NEXT (7b slice SL; docs/CONTRACT.md "Phase 7b", "Slice SL as built"): a site lot's {@code site} (the SiteSpec wire) read into
 * {@link LotSpec#site()} (pad lots unchanged), the feature siteLots, the general freeze box, the bind check, the region-store and
 * side-blob volume lookups, and the second plan of an elevated plan/0.
 */
class ApiSLTest {
	private static final Path TRUNK = Path.of("../kit/test/fixtures/site/trunk");

	private static JsonObject trunkSpec() throws Exception {
		return JsonParser.parseString(Files.readString(TRUNK.resolve("site.json"))).getAsJsonObject().getAsJsonObject("spec");
	}

	private static JsonObject box(int x0, int y0, int z0, int x1, int y1, int z1) {
		return SiteSpec.box(new net.minecraft.world.level.levelgen.structure.BoundingBox(x0, y0, z0, x1, y1, z1));
	}

	/** An IR with a pad lot and a site lot (the trunk fixture's spec, lotId set). */
	private static JsonObject ir() throws Exception {
		JsonObject o = JsonParser.parseString("""
			{"format":2,"id":"t","kitVersion":"0","seed":"1","claim":{"minX":3300,"minY":-64,"minZ":-1600,"maxX":3555,"maxY":319,"maxZ":-1345},
			 "stages":["lots"],"tiles":{},"parts":[],"lots":[]}
			""").getAsJsonObject();
		JsonObject pad = new JsonObject();
		pad.addProperty("id", "pad_1");
		pad.addProperty("stage", "lots");
		pad.add("box", box(3400, 64, -1500, 3409, 79, -1491));
		pad.addProperty("floorY", 64);
		pad.addProperty("front", "south");
		pad.add("max", JsonParser.parseString("[10,16,10]"));
		JsonObject site = new JsonObject();
		site.addProperty("id", "hut_1");
		site.addProperty("stage", "lots");
		site.add("box", box(3448, 64, -1480, 3463, 83, -1465));
		site.addProperty("floorY", 64);
		site.addProperty("front", "south");
		site.add("max", JsonParser.parseString("[16,20,16]"));
		JsonObject spec = trunkSpec();
		spec.addProperty("lotId", "hut_1");
		site.add("site", spec);
		site.add("affordance", JsonParser.parseString("{\"id\":\"trunk_0123456789abcdef\",\"kind\":\"trunk\"}"));
		site.add("host", com.google.gson.JsonNull.INSTANCE);
		o.getAsJsonArray("lots").add(pad);
		o.getAsJsonArray("lots").add(site);
		return o;
	}

	@Test
	void theViewReadsASiteLotsSite() throws Exception {
		Ir ir = Ir.of(ir());
		RegionsImpl.PlanRec p = new RegionsImpl.PlanRec("p1", "prog", "", "sha", "survey", 1L, "minecraft:overworld", ir.claim(), null, new JsonObject(),
			new JsonObject(), ir, 0, 0, null, null);
		RegionPlan v = RegionsImpl.view(p);
		LotSpec pad = v.lots().get(0), hut = v.lots().get(1);
		assertNull(pad.site(), "a pad lot has no site (the 1.8.0 constructor's)");
		assertEquals(new LotSpec(pad.id(), pad.stage(), pad.lot(), pad.floorY(), pad.front(), pad.brief(), pad.max(), pad.ext()), pad);
		assertNotNull(hut.site());
		assertEquals(FitMode.WRAP_TRUNK, hut.site().fit());
		assertEquals("hut_1", hut.site().lotId());
		assertEquals(260, hut.site().keepCritical().size());
		JsonObject want = trunkSpec();
		want.addProperty("lotId", "hut_1");
		assertEquals(SiteSpec.fromWire(want), hut.site());
		assertFalse(hut.ext().has("site"), "the site is LotSpec.site, not the lot's ext");
	}

	@Test
	void aMalformedSiteLeavesTheLotWithoutOne() throws Exception {
		JsonObject o = ir();
		o.getAsJsonArray("lots").get(1).getAsJsonObject().getAsJsonObject("site").addProperty("fit", "hover");
		Ir ir = Ir.of(o);
		RegionPlan v = RegionsImpl.view(new RegionsImpl.PlanRec("p1", "prog", "", "sha", "survey", 1L, "minecraft:overworld", ir.claim(), null,
			new JsonObject(), new JsonObject(), ir, 0, 0, null, null));
		assertNull(v.lots().get(1).site());
		assertThrows(IllegalArgumentException.class, () -> SiteLots.siteOf(o, "hut_1"), "the realise fails such a lot's item");
	}

	@Test
	void siteOfReadsTheIrByLotId() throws Exception {
		JsonObject o = ir();
		assertNull(SiteLots.siteOf(o, "pad_1"));
		assertNull(SiteLots.siteOf(o, "no_such"));
		assertEquals("hut_1", SiteLots.siteOf(o, "hut_1").lotId());
		assertTrue(SiteLots.isSiteLot(SiteLots.lotJson(o, "hut_1")));
		assertFalse(SiteLots.isSiteLot(SiteLots.lotJson(o, "pad_1")));
	}

	@Test
	void siteLotsFeature() {
		assertTrue(ApiRules.features(2, List.of("region.siteLots")).contains("siteLots"));
		assertFalse(ApiRules.features(1, List.of("region.siteLots")).contains("siteLots"));
		assertFalse(ApiRules.features(2, List.of("region.plan", "site.analyse")).contains("siteLots"));
	}

	@Test
	void theGeneralFreezeCoversTheSiteVolume() throws Exception {
		SiteSpec s = SiteLots.siteOf(ir(), "hut_1");
		Anchors.Bounds snap = new Anchors.Bounds(3448, 63, -1480, 3463, 83, -1465);
		Anchors.Bounds f = SiteLots.freezeBox(snap, s);
		assertEquals(new Anchors.Bounds(3440, 63, -1488, 3471, 83, -1457), f, "the lot box + 8 in x and z; y is the snapshot's");
		Anchors.Bounds wide = new Anchors.Bounds(3430, 60, -1490, 3480, 90, -1450);
		assertEquals(wide, SiteLots.freezeBox(wide, s), "never smaller than the snapshot");
	}

	@Test
	void theBindCheck() throws Exception {
		SiteSpec s = SiteLots.siteOf(ir(), "hut_1");
		JsonArray box = JsonParser.parseString("[3448,64,-1480,3463,83,-1465]").getAsJsonArray();
		assertNull(SiteLots.bindProblem("hut_1", "e1", s, box, 16, 20, 16, null), "exactly the box, unbound");
		String small = SiteLots.bindProblem("hut_1", "e1", s, box, 15, 20, 16, null);
		assertNotNull(small);
		assertTrue(small.contains("is not the site lot's box"), small);
		// the IR's box form too
		assertNotNull(SiteLots.bindProblem("hut_1", "e1", s, box(3448, 64, -1480, 3463, 82, -1465), 16, 20, 16, null));
		// bound to this volume: binds; to another: SITE_MISMATCH
		JsonObject same = new JsonObject();
		same.add("site", trunkSpec());
		assertNull(SiteLots.bindProblem("hut_1", "e1", s, box, 16, 20, 16, same));
		JsonObject other = new JsonObject();
		JsonObject ext = new JsonObject();
		ext.add(SiteBinding.EXT_KEY, new SiteBinding("a".repeat(64), FitMode.WRAP_TRUNK, "hut_1", s.volume(), null).wire());
		other.add("ext", ext);
		String mis = SiteLots.bindProblem("hut_1", "e1", s, box, 16, 20, 16, other);
		assertNotNull(mis);
		assertTrue(mis.contains("SITE_MISMATCH") && mis.contains("a".repeat(64)), mis);
		// a turned frame: the design's x and z swap
		JsonObject turned = trunkSpec();
		turned.getAsJsonObject("frame").addProperty("rotation", "clockwise_90");
		SiteSpec t = SiteSpec.fromWire(turned);
		JsonArray wide = JsonParser.parseString("[3448,64,-1480,3463,83,-1471]").getAsJsonArray();
		assertNull(SiteLots.bindProblem("hut_1", "e1", t, wide, 10, 20, 16, null));
		assertNotNull(SiteLots.bindProblem("hut_1", "e1", t, wide, 16, 20, 10, null));
		assertEquals(Rotation.CLOCKWISE_90.ordinal(), SiteLots.turns(t));
	}

	@Test
	void anUnknownEntryOnASiteLotIsRefusedAtBind() throws Exception {
		JsonObject lot = SiteLots.lotJson(ir(), "hut_1").deepCopy();
		lot.add("box", JsonParser.parseString("[3448,64,-1480,3463,83,-1465]"));
		String why = PlanChecks.siteLotProblem("hut_1", "no_such_entry_sl", lot);
		assertNotNull(why);
		assertTrue(why.contains("no library entry"), why);
		JsonObject bad = lot.deepCopy();
		bad.getAsJsonObject("site").addProperty("fit", "hover");
		assertTrue(PlanChecks.siteLotProblem("hut_1", "x", bad).contains("malformed"));
	}

	@Test
	void theVolumeIsFoundInTheRegionStoreOrItsSideBlob(@TempDir Path world) throws Exception {
		byte[] gz = Files.readAllBytes(TRUNK.resolve("volume.bin"));
		String sha = Arvx.sha256(Arvx.gunzip(gz));
		assertEquals(trunkSpec().get("volumeSha").getAsString(), sha);
		assertNull(SiteFit.volumeFile(world, sha), "nowhere yet");
		// a region's own copy
		Path reg = RegionStore.region(world, "rg3").resolve("volumes").resolve(sha + ".bin");
		Files.createDirectories(reg.getParent());
		Files.write(reg, gz);
		assertEquals(reg, SiteFit.volumeFile(world, sha));
		Files.delete(reg);
		// only the IR's side blob (kind volume, named by its gzip bytes' sha): found, checked and frozen into architect/volumes
		String blobSha = Packed.sha256(gz);
		Path blob = RegionBlobs.file(world, "rg3", blobSha);
		Files.createDirectories(blob.getParent());
		Files.write(blob, gz);
		List<Ir.BlobRef> blobs = List.of(new Ir.BlobRef("tile_x", "b".repeat(64), 1, "columns"), new Ir.BlobRef("site_hut_1", blobSha, gz.length, "volume"));
		assertNull(SiteFit.fromRegionBlobs(world, "c".repeat(64), List.of("rg3"), List.of(blobs)), "another sha: none");
		Path frozen = SiteFit.fromRegionBlobs(world, sha, List.of("rg3"), List.of(blobs));
		assertEquals(world.resolve(VolumeSurvey.STANDALONE_DIR).resolve(sha + ".bin"), frozen);
		assertEquals(sha, Arvx.sha256(Arvx.gunzip(Files.readAllBytes(frozen))));
		assertEquals(frozen, SiteFit.volumeFile(world, sha), "PL's read path finds it from then");
	}

	@Test
	void anElevatedPlanPlansTwice() {
		JsonObject flat = JsonParser.parseString("{\"zones\":[{\"id\":\"z\",\"program\":{\"layout\":\"street\",\"lots\":[]}}]}").getAsJsonObject();
		JsonObject up = JsonParser.parseString("{\"zones\":[{\"id\":\"z\",\"program\":{\"layout\":\"elevated\",\"lots\":[]}}]}").getAsJsonObject();
		JsonObject dist = JsonParser.parseString("{\"zones\":[{\"id\":\"z\",\"program\":{\"districts\":[{\"id\":\"d\",\"layout\":\"elevated\",\"lots\":[]}]}}]}")
			.getAsJsonObject();
		JsonObject noted = JsonParser.parseString("{\"zones\":[{\"id\":\"z\",\"notes\":\"elevated\",\"program\":{\"lots\":[]}}],\"connectors\":[]}")
			.getAsJsonObject();
		assertFalse(PlanChecks.hasElevated(flat));
		assertTrue(PlanChecks.hasElevated(up));
		assertTrue(PlanChecks.hasElevated(dist));
		assertFalse(PlanChecks.hasElevated(noted), "only a layout member counts");
		assertFalse(PlanChecks.hasElevated(new JsonObject()));
	}
}
