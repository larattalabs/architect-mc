package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** 6c slice 0c §6 and gate item 5 (unit): the re-pause warning in the sidecar's double arithmetic. */
class ExtensionTest {
	@Test
	void theLive6bCase() {
		// $30 -> $35 with $31 spent: the 80% line is $28, under the spend: it pauses again
		Extension e = Extension.of(null, 35, 31, 0.8);
		assertTrue(e.pausesAgain());
		assertEquals(28.0, e.softLineUsd(), 1e-9);
		assertEquals(38.76, e.minBudgetUsd());
		// at $38.75 the line is exactly $31.00, which pauses (equality pauses)
		assertEquals(31.0, 0.8 * 38.75);
		assertTrue(Extension.of(null, 38.75, 31, 0.8).pausesAgain());
		assertFalse(Extension.of(null, 38.76, 31, 0.8).pausesAgain());
	}

	@Test
	void minBudgetIsTheSmallestWholeCentAboveTheLine() {
		double[] fractions = {0.8, 0.5, 0.75, 0.9, 1.0, 0.33};
		for (double f : fractions) {
			for (int c = 0; c <= 5000; c += 7) {
				double spent = c / 100.0 + (c % 3) * 0.001;
				double min = Extension.minBudgetUsd(spent, f);
				long cents = Math.round(min * 100);
				assertEquals(cents / 100.0, min, "whole cents");
				assertTrue(spent < f * min, spent + " at " + f + ": " + min + " doesn't pause");
				assertTrue(cents == 1 || !(spent < f * ((cents - 1) / 100.0)), spent + " at " + f + ": a cent less pauses");
			}
		}
	}
}
