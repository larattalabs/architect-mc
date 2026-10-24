package dev.larattalabs.architect.design;

import org.jspecify.annotations.Nullable;

/**
 * (Style unification U3) Words alongside a picked Style: "mossy, lived-in" with Medieval. The request's {@code style} stays the Style
 * (its id or name: at most {@value DesignSpec#MAX_STYLE} characters, and what the entry's provenance shows), its {@code palette} the
 * Style's roles; the words go first in {@code notes}, on a line of their own: {@code "Style: mossy, lived-in"}, then a blank line and
 * the notes. No new wire field, so every helper takes it. Free text alone (no Style) is still the request's style with no palette
 * (U2); a note is only sent with a Style. A remix reads the line back ({@link #split}). Pure.
 */
public final class StyleNote {
	public static final int MAX = 120;
	public static final String PREFIX = "Style: ";

	/** A note and the notes it was taken from (a remix's prefill). */
	public record Split(String note, String notes) {
	}

	private StyleNote() {
	}

	/** The notes as sent: the note's line first when there is a note, else the notes unchanged. */
	public static String compose(@Nullable String note, @Nullable String notes) {
		String n = note == null ? "" : note.strip().replaceAll("\\s*\\R\\s*", " ");
		String rest = notes == null ? "" : notes;
		if (n.isEmpty()) {
			return rest;
		}
		return rest.isBlank() ? PREFIX + n : PREFIX + n + "\n\n" + rest;
	}

	/** Back from sent notes: a first line {@code "Style: …"} is the note, the rest (after its blank line) the notes. */
	public static Split split(@Nullable String sent) {
		if (sent == null || !sent.startsWith(PREFIX)) {
			return new Split("", sent == null ? "" : sent);
		}
		int nl = sent.indexOf('\n');
		String note = (nl < 0 ? sent : sent.substring(0, nl)).substring(PREFIX.length()).strip();
		String rest = nl < 0 ? "" : sent.substring(nl + 1).replaceFirst("^\\R", "");
		return new Split(note, rest);
	}
}
