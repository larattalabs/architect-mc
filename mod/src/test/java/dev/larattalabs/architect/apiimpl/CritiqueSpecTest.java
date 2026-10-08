package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.CritiqueMode;
import dev.larattalabs.architect.api.CritiqueSpec;
import java.util.List;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

/** {@link CritiqueSpec} and its builder: the protocol's bounds (sidecar/src/protocol.ts CritiqueSpec), checked on build. */
class CritiqueSpecTest {
	private static String refused(Consumer<CritiqueSpec.Builder> f) {
		CritiqueSpec.Builder b = CritiqueSpec.builder(CritiqueMode.LOOP);
		f.accept(b);
		return assertThrows(IllegalArgumentException.class, b::build).getMessage();
	}

	@Test
	void defaults() {
		CritiqueSpec s = CritiqueSpec.loop();
		assertEquals(CritiqueMode.LOOP, s.mode());
		assertNull(s.maxRevisions());
		assertTrue(s.views().isEmpty());
		assertTrue(s.on());
		assertFalse(CritiqueSpec.OFF.on());
		assertEquals(CritiqueMode.REPORT, CritiqueSpec.report().mode());
		assertEquals(2, CritiqueSpec.loop(2).maxRevisions());
		assertEquals(CritiqueMode.OFF, new CritiqueSpec(null, null, null, null, null, null, null, null, null, null).mode(), "null mode = off");
	}

	@Test
	void bounds() {
		assertTrue(refused(b -> b.maxRevisions(4)).contains("maxRevisions"));
		assertTrue(refused(b -> b.maxRevisions(-1)).contains("maxRevisions"));
		assertEquals(0, CritiqueSpec.builder(CritiqueMode.LOOP).maxRevisions(0).build().maxRevisions());
		assertEquals(3, CritiqueSpec.builder(CritiqueMode.LOOP).maxRevisions(3).build().maxRevisions());
		assertTrue(refused(b -> b.effort("xhigh")).contains("effort"));
		assertTrue(refused(b -> b.budgetUsd(0.0)).contains("budgetUsd"));
		assertTrue(refused(b -> b.budgetUsd(1000.5)).contains("budgetUsd"));
		assertTrue(refused(b -> b.budgetUsd(Double.NaN)).contains("budgetUsd"));
		assertTrue(refused(b -> b.maxMinutes(241.0)).contains("maxMinutes"));
		assertTrue(refused(b -> b.shipScore(0.5)).contains("shipScore"));
		assertTrue(refused(b -> b.shipScore(10.5)).contains("shipScore"));
		assertTrue(refused(b -> b.views(List.of("iso", "section"))).contains("section"));
		assertTrue(refused(b -> b.views(List.of("iso", "iso"))).contains("twice"));
		assertTrue(refused(b -> b.model("not a model!")).contains("model"));
		assertTrue(refused(b -> b.extraCriteria(List.of("a", "b", "c", "d"))).contains("at most 3"));
		assertTrue(refused(b -> b.extraCriterion("   ")).contains("extra criterion"));
		assertTrue(refused(b -> b.extraCriterion("x".repeat(201))).contains("extra criterion"));
		assertEquals(List.of("reads as a mine"), CritiqueSpec.builder(CritiqueMode.LOOP).extraCriterion("  reads as a mine ").build().extraCriteria(),
			"criteria are stripped");
		assertNull(CritiqueSpec.builder(CritiqueMode.LOOP).model("  ").build().model(), "a blank model = the default");
		assertEquals(CritiqueSpec.VIEWS, CritiqueSpec.builder(CritiqueMode.REPORT).views(CritiqueSpec.VIEWS).build().views());
	}

	@Test
	void toBuilderCopies() {
		CritiqueSpec s = CritiqueSpec.builder(CritiqueMode.LOOP).maxRevisions(1).budgetUsd(2.0).views(List.of("iso")).extraCriterion("x").neighbours(true)
			.build();
		assertEquals(s, s.toBuilder().build());
		assertEquals(CritiqueMode.REPORT, s.toBuilder().mode(CritiqueMode.REPORT).build().mode());
	}

	@Test
	void modes() {
		assertEquals(CritiqueMode.LOOP, CritiqueMode.of("loop"));
		assertEquals(CritiqueMode.REPORT, CritiqueMode.of("REPORT"));
		assertEquals(CritiqueMode.OFF, CritiqueMode.of("polish"));
		assertEquals(CritiqueMode.OFF, CritiqueMode.of(null));
		assertEquals("report", CritiqueMode.REPORT.wire());
	}
}
