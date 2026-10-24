package dev.larattalabs.architect.placement;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** UI-2b: the placement HUD's grouped verdict. */
class VerdictSummaryTest {
	@Test
	void oneIssueIsNamedInTheHeadline() {
		VerdictSummary v = VerdictSummary.of("Would be refused", List.of("you are standing in the box"));
		assertEquals("Would be refused: you are standing in the box", v.headline());
		assertFalse(v.expandable());
		assertEquals(List.of(), v.detail());
	}

	@Test
	void severalAreCountedAndListedOnExpand() {
		VerdictSummary v = VerdictSummary.of("Would be refused", List.of("a chest is in the way", "it overlaps cabin_2", "", "a chest is in the way",
			"too steep"));
		assertEquals("Would be refused: 3 issues", v.headline(), "duplicates and blanks dropped");
		assertTrue(v.expandable());
		assertEquals(List.of("• a chest is in the way", "• it overlaps cabin_2", "• too steep"), v.detail());
	}

	@Test
	void theDetailIsCapped() {
		List<String> many = new ArrayList<>();
		for (int i = 0; i < 9; i++) {
			many.add("issue " + i);
		}
		VerdictSummary v = VerdictSummary.of("The server would refuse", many);
		assertEquals("The server would refuse: 9 issues", v.headline());
		assertEquals(VerdictSummary.MAX_DETAIL + 1, v.detail().size());
		assertEquals("+3 more", v.detail().get(VerdictSummary.MAX_DETAIL));
	}

	@Test
	void noIssuesIsTheBarePrefix() {
		assertEquals("Would be refused", VerdictSummary.of("Would be refused", List.of()).headline());
	}
}
