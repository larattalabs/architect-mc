package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.lang.reflect.Modifier;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/**
 * API 1.15.0 (docs/CONTRACT.md phase 6c slice Y2, C25 and C26): the old constructors are kept (binary compatibility), the new record
 * components are trailing, the new interface method is a default that throws, and no Reason is added.
 */
class ApiY2Test {
	@org.junit.jupiter.api.BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	@Test
	void version() {
		String[] v = ArchitectApi.VERSION.split("\\.");
		assertTrue(Integer.parseInt(v[0]) == 1 && Integer.parseInt(v[1]) >= 15, ArchitectApi.VERSION); // later slices append
	}

	@Test
	void featuresAreAlwaysThere() {
		Set<String> f = ApiRules.features(1, List.of());
		assertTrue(f.contains("siteWaiting") && f.contains("fullBom"), f.toString());
	}

	@Test
	void verdictKeepsItsOldConstructorsAndAppendsTheBill() throws Exception {
		var rc = Verdict.class.getRecordComponents();
		assertEquals("bomExact", rc[rc.length - 1].getName());
		assertEquals("bomFull", rc[rc.length - 2].getName());
		assertEquals("spans", rc[rc.length - 3].getName());
		// the 1.12.0 shape, by descriptor
		Verdict.class.getConstructor(List.class, List.class, boolean.class, Map.class, Optional.class, Optional.class, List.class, int.class, List.class);
		Verdict old = new Verdict(List.of(), List.of(), true, Map.of(), Optional.empty(), Optional.empty(), List.of(), 0, List.of());
		assertEquals(Map.of(), old.bomFull());
		assertEquals(false, old.bomExact());
		Verdict older = new Verdict(List.of(), List.of(), true, Map.of(), Optional.empty(), Optional.empty());
		assertEquals(Map.of(), older.bomFull());
		Verdict nul = new Verdict(List.of(), List.of(), true, Map.of(), Optional.empty(), Optional.empty(), List.of(), 0, List.of(), null, true);
		assertEquals(Map.of(), nul.bomFull());
		assertTrue(nul.bomExact());
	}

	@Test
	void siteViewKeepsItsOldConstructorsAndAppendsTheWait() throws Exception {
		var rc = SiteView.class.getRecordComponents();
		assertEquals("siteWait", rc[rc.length - 1].getName(), "the contract's 'wait' clashes with Object.wait()");
		assertEquals("region", rc[rc.length - 2].getName());
		// the 1.8.0 shape (region last), by descriptor
		SiteView.class.getConstructor(String.class, String.class, String.class, JsonObject.class, BoundingBox.class, BoundingBox.class, Rotation.class,
			ResourceKey.class, State.class, int.class, int.class, String.class, String.class, String.class, String.class, Policy.class, List.class,
			List.class, int.class, int.class, int.class, boolean.class, String.class);
		SiteView v = new SiteView("s1", "cabin", null, new JsonObject(), new BoundingBox(BlockPos.ZERO), new BoundingBox(BlockPos.ZERO), Rotation.NONE,
			Level.OVERWORLD, State.BUILT, 0, 0, null, null, null, "building", Policy.BOX, List.of(), List.of(), 1, 1, 0, false, "r1");
		assertNull(v.siteWait());
		assertEquals("r1", v.region());
	}

	@Test
	void waitingIsADefaultThatThrows() throws Exception {
		var method = Sites.class.getMethod("waiting", String.class);
		assertTrue(method.isDefault());
		assertTrue(!Modifier.isAbstract(method.getModifiers()));
	}

	@Test
	void siteWaitingIsANewStaticEvent() throws Exception {
		assertTrue(Modifier.isStatic(SiteEvents.class.getField("SITE_WAITING").getModifiers()));
		SiteWait w = new SiteWait("s1", true, 100L, null, 0);
		assertEquals(List.of(), w.nextNeeded());
	}

	@Test
	void noReasonAdded() {
		Reason[] r = Reason.values();
		assertEquals(Reason.FIELD_LIMIT, r[r.length - 1]);
	}
}
