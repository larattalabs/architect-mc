package dev.larattalabs.architect.design;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Critique;
import dev.larattalabs.architect.api.Estimate;
import dev.larattalabs.architect.apiimpl.Wire5a;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The pure rules behind the phase 5a UI: the toggle and its spec, the estimate line, the rounds, scores and issues, the report action. */
class CritiqueRulesTest {
	private static Critique critique(String json) {
		return Wire5a.record(JsonParser.parseString(json)).orElseThrow();
	}

	static final String TWO_ROUNDS = """
		{"mode":"loop","rounds":[
		 {"n":0,"verdict":"iterate","overall":5,"scores":{"silhouette":5},"issues":[{"priority":"P1","part":"roof","view":"iso","what":"a","fix":"b"},
		   {"priority":"P0","part":null,"view":"front","what":"no door","fix":"add one"}],"resolved":[],"ship":false,"cost":0.05,"ms":1,"kept":true},
		 {"n":1,"verdict":"ship","overall":8,"scores":{"brief":8,"craft":7,"silhouette":8,"bible":9},"issues":[{"priority":"P2","part":"porch","view":"iso_back",
		   "what":"bare","fix":""}],"resolved":[0,1],"ship":true,"cost":0.5,"ms":1,"kept":true}],
		 "best":1,"end":"ship","overall":8,"cost":{"critic":{"usd":0.1},"revise":{"usd":0.45}}}""";

	@Test
	void toggleDefaultsOffAndSendsALoop() {
		assertFalse(CritiqueRules.DEFAULT_ON, "N1: the UI default stays off");
		assertEquals(List.of(1, 2), CritiqueRules.REVISION_CHOICES);
		assertNull(CritiqueRules.spec(false, 2, true), "off: no critique");
		assertNull(CritiqueRules.spec(true, 2, false), "a helper without the loop: nothing sent");
		JsonObject s = CritiqueRules.spec(true, 1, true);
		assertNotNull(s);
		assertEquals("loop", s.get("mode").getAsString());
		assertEquals(1, s.get("maxRevisions").getAsInt());
		assertEquals(2, CritiqueRules.spec(true, 7, true).get("maxRevisions").getAsInt(), "outside 1-2: the default");
		assertEquals("report", CritiqueRules.reportSpec().get("mode").getAsString());
	}

	@Test
	void estimateLine() {
		Estimate plain = new Estimate(0.8, 2.5, 4, 10, "seed");
		assertEquals("about $0.80-2.50, 4-10 min", CritiqueRules.estimateLine(plain));
		Estimate with = new Estimate(0.8, 2.5, 4, 10, "seed", true, 0.04, 2.25, 0.5, 12, List.of());
		assertEquals("about $0.80-2.50, 4-10 min · with critique $0.84-4.75, 4.5-22 min", CritiqueRules.estimateLine(with));
		assertEquals("Critique (~$0.04-0.15)", CritiqueRules.reportLabel(null), "the critic seed before the helper answers");
		assertEquals("Critique (~$0.06-0.12)", CritiqueRules.reportLabel(new Estimate(1, 2, 3, 4, "", true, 0.06, 0.12, 0.5, 2, List.of())));
	}

	@Test
	void roundsWithTheBestMarked() {
		Critique c = critique(TWO_ROUNDS);
		List<String> lines = CritiqueRules.roundLines(c);
		assertEquals("round 0  5.0  2 issues", lines.get(0));
		assertEquals("round 1  8.0  ships  1 issue, 2 resolved  ★ best", lines.get(1));
		assertEquals("Critique: shipped at round 1 (8.0)", CritiqueRules.endLine(c));
		assertEquals("critique 8.0, shipped", CritiqueRules.brief(c));
	}

	@Test
	void runningAndFailedRounds() {
		Critique running = critique("""
			{"mode":"loop","rounds":[{"n":0,"verdict":"iterate","overall":6.2,"scores":{},"issues":[],"resolved":[],"ship":false,"cost":0,"ms":0,"kept":true},
			 {"n":1,"verdict":null,"overall":null,"scores":{},"issues":[],"resolved":[],"ship":false,"cost":0,"ms":0,"kept":true}],"pending":"critic",
			 "cost":{"critic":{"usd":0},"revise":{"usd":0}}}""");
		List<String> lines = CritiqueRules.roundLines(running);
		assertEquals("round 0  6.2  0 issues  ★ best", lines.get(0), "the best so far is marked while the loop runs");
		assertEquals("round 1  waiting for the critic", lines.get(1));
		assertEquals("critiquing round 1 (best 6.2)", CritiqueRules.brief(running));
		assertEquals("Critique: critiquing round 1 (best 6.2)", CritiqueRules.endLine(running));
		Critique ended = critique("""
			{"mode":"loop","rounds":[{"n":0,"verdict":"iterate","overall":6.2,"scores":{},"issues":[],"resolved":[],"ship":false,"cost":0,"ms":0,"kept":true},
			 {"n":1,"verdict":null,"overall":null,"scores":{},"issues":[],"resolved":[],"ship":false,"cost":0,"ms":0,"kept":false,"error":"check failed: holes"}],
			 "best":0,"end":"check_failed","overall":6.2,"cost":{"critic":{"usd":0},"revise":{"usd":0}}}""");
		assertEquals("round 1  check failed: holes", CritiqueRules.roundLines(ended).get(1));
		assertEquals("Critique: ended (check failed), best round 0 (6.2)", CritiqueRules.endLine(ended));
		Critique report = critique("""
			{"mode":"report","rounds":[{"n":0,"verdict":null,"overall":null,"scores":{},"issues":[],"resolved":[],"ship":false,"cost":0,"ms":0,"kept":true,
			 "error":"the critic call failed twice"}],"best":0,"end":"critic_failed","cost":{"critic":{"usd":0},"revise":{"usd":0}}}""");
		assertEquals("Report: ended (critic failed), best round 0", CritiqueRules.endLine(report));
		assertEquals("critique: critic failed", CritiqueRules.brief(report));
		Critique scored = critique("""
			{"mode":"report","rounds":[{"n":0,"verdict":"iterate","overall":5,"scores":{"craft":5},"issues":[],"resolved":[],"ship":false,"cost":0.05,"ms":0,
			 "kept":true}],"best":0,"end":"max_revisions","overall":5,"cost":{"critic":{"usd":0.05},"revise":{"usd":0}}}""");
		assertEquals("Report: scored 5.0", CritiqueRules.endLine(scored), "a report is one critic call: no loop end reason shown");
		assertEquals("report 5.0", CritiqueRules.brief(scored));
	}

	@Test
	void scoresAndIssues() {
		Map<String, Integer> sc = new LinkedHashMap<>();
		sc.put("extra1", 6);
		sc.put("brief", 8);
		sc.put("silhouette", 7);
		sc.put("bible", 9);
		assertEquals("silhouette 7 · brief 8 · bible 9 · extra1 6", CritiqueRules.scoresLine(sc), "the rubric's order, extras last");
		List<String> is = CritiqueRules.issueLines(List.of(new Critique.Issue(Critique.Priority.P2, "porch", "iso_back", "bare", ""), new Critique.Issue(
			Critique.Priority.P0, null, "front", "no door", "add one")));
		assertEquals("P0 whole building (front): no door → add one", is.get(0), "worst first");
		assertEquals("P2 porch (iso_back): bare", is.get(1));
	}

	@Test
	void reportAction() {
		assertNull(CritiqueRules.reportRefusal(false, false, true, true));
		assertTrue(CritiqueRules.reportRefusal(true, false, true, true).contains("bundled"));
		assertTrue(CritiqueRules.reportRefusal(false, false, false, true).contains("5a"));
		assertTrue(CritiqueRules.reportRefusal(false, false, true, false).contains("not running"));
	}
}
