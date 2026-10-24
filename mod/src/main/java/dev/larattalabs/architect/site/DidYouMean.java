package dev.larattalabs.architect.site;

import dev.larattalabs.labui.ui.TextMatch;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;

/**
 * "Did you mean" for an unknown design id (UI-2b; pure, unit-tested in {@code DidYouMeanTest}). Replaces the old "Unknown design
 * 'x' (known: [every id])". A candidate counts when lab-ui's {@link TextMatch} finds every word of the input in it (a prefix or a
 * part: "cab" finds {@code cabin_oak}), or when it is within a small edit distance of the input or of one of its words (a typo:
 * "cabn" finds {@code cabin}). Best first: whole-text matches by TextMatch's score, then by edit distance; at most
 * {@code max}.
 */
public final class DidYouMean {
	/** How many close matches the message names. */
	public static final int MAX = 5;

	private DidYouMean() {
	}

	/** Up to {@code max} ids close to {@code input}, best first (empty when nothing is close). */
	public static List<String> suggest(String input, Collection<String> ids, int max) {
		String q = TextMatch.norm(input);
		if (q.isEmpty() || max <= 0) {
			return List.of();
		}
		record Scored(String id, int tier, int score, int order) {
		}
		List<Scored> out = new ArrayList<>();
		int order = 0;
		for (String id : ids) {
			int s = TextMatch.score(input, id, List.of());
			if (s >= 0) {
				out.add(new Scored(id, 0, -s, order++));
				continue;
			}
			int d = distance(q, TextMatch.norm(id));
			for (String w : TextMatch.norm(id).split(" ")) {
				d = Math.min(d, distance(q, w));
			}
			if (d <= allowed(q)) {
				out.add(new Scored(id, 1, d, order++));
			}
		}
		out.sort(Comparator.comparingInt(Scored::tier).thenComparingInt(Scored::score).thenComparingInt(Scored::order));
		List<String> ids2 = new ArrayList<>();
		for (Scored s : out) {
			if (ids2.size() >= max) {
				break;
			}
			ids2.add(s.id());
		}
		return ids2;
	}

	/** The edits a typo may make: 1 for a short id, 2 from 5 letters, 3 from 9. */
	static int allowed(String q) {
		int n = q.replace(" ", "").length();
		return n < 5 ? 1 : n < 9 ? 2 : 3;
	}

	/** Optimal string alignment distance (insert, delete, substitute, swap two neighbours). */
	static int distance(String a, String b) {
		int n = a.length();
		int m = b.length();
		int[][] d = new int[n + 1][m + 1];
		for (int i = 0; i <= n; i++) {
			d[i][0] = i;
		}
		for (int j = 0; j <= m; j++) {
			d[0][j] = j;
		}
		for (int i = 1; i <= n; i++) {
			for (int j = 1; j <= m; j++) {
				int cost = a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1;
				d[i][j] = Math.min(Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1), d[i - 1][j - 1] + cost);
				if (i > 1 && j > 1 && a.charAt(i - 1) == b.charAt(j - 2) && a.charAt(i - 2) == b.charAt(j - 1)) {
					d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
				}
			}
		}
		return d[n][m];
	}

	/**
	 * The one-line message: "Unknown design 'cabn'. Did you mean cabin, cabin_dark? See /architect list", or without close
	 * matches "Unknown design 'zzz'. See /architect list".
	 */
	public static String message(String input, Collection<String> ids) {
		List<String> s = suggest(input, ids, MAX);
		return "Unknown design '" + input + "'." + (s.isEmpty() ? "" : " Did you mean " + String.join(", ", s) + "?") + " See /architect list";
	}
}
