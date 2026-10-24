package dev.larattalabs.architect.client.screen;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.Estimate;
import dev.larattalabs.architect.client.design.SetFeature;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.client.ui.UiStyle;
import dev.larattalabs.labui.client.widget.Button;
import java.util.List;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import org.jspecify.annotations.Nullable;

/**
 * (Style unification U5b) "Add parts…": Claude drafts a component set (parts) for an existing Style as a bible job seeded from it
 * ({@code bible.parts}: its roles, hints, tags and owner kept, no drafting pass; the sim helper takes the kit's reference parts at $0).
 * The helper's estimate ({@code bible.estimate {parts: true}}) shows before anything is sent. The player's Style gets a new version; a
 * built-in's parts go on the player's copy of it ("<name> (parts)"), the built-in stays the kit's. A mod's Style is refused (only its
 * owner adds parts). Client thread.
 */
final class AddPartsScreen extends U3Screen {
	/** Until the helper answers: a bible job's ballpark (parts skip its drafting pass, so this is an upper bound). */
	static final String SEED_COST = "at most a bible job: about $1.20-1.60, 5-8 min (Claude drafts the parts and a sample sheet)";
	private static volatile @Nullable Estimate estimate;
	private static volatile boolean asked;
	static volatile @Nullable String lastJob;

	private final Bible style;
	private final Button go = new Button("Draft parts", this::send).primary(true);
	private final Button cancel = new Button("Cancel", this::back);
	private @Nullable String status;
	private boolean statusError;
	private boolean sending;

	AddPartsScreen(Bible style, @Nullable Screen parent) {
		super("Add parts", parent);
		this.style = style;
		askEstimate();
	}

	/** The helper's estimate for an "Add parts" job once it answered, else the ballpark. */
	static String costLine() {
		Estimate e = estimate;
		askEstimate();
		return e == null ? SEED_COST : "Claude drafts them: " + dev.larattalabs.architect.design.CritiqueRules.estimateLine(e) + " (at most)";
	}

	private static void askEstimate() {
		if (asked || !Sidecar.connected() || !SetFeature.has("bible.parts")) {
			return;
		}
		asked = true;
		JsonObject m = new JsonObject();
		m.addProperty("type", "bible.estimate");
		m.addProperty("parts", true);
		Sidecar.link().send(m).whenComplete((ack, err) -> {
			if (err == null && ack.ok() && ack.result() != null) {
				try {
					estimate = dev.larattalabs.architect.apiimpl.Wire5a.estimate(ack.result());
				} catch (RuntimeException ex) {
					asked = false;
				}
			} else {
				asked = false;
			}
		});
	}

	/** What the job makes: the next version of the player's Style, or a copy of a built-in. */
	String outcome() {
		if (style.builtin()) {
			return "A copy of " + style.name() + " with parts, yours (\"" + style.name() + " (parts)\"); the built-in stays as it is.";
		}
		return style.name() + " v" + (style.version() + 1) + ", with parts; v" + style.version() + " stays as it is.";
	}

	/** Why it can't be sent now, or null. */
	@Nullable String refusal() {
		if (style.modOwned()) {
			return "Owned by a mod: only its owner adds parts. Duplicate it to make your own.";
		}
		if (!Sidecar.connected()) {
			return "The design helper is not running (Status tab).";
		}
		if (!SetFeature.has("bible.parts")) {
			return "This design helper can't add parts (needs Style unification U5).";
		}
		return null;
	}

	@Override
	protected String title() {
		return "Add parts · " + style.name();
	}

	@Override
	protected String hint() {
		return "Ctrl+Enter draft · Esc back";
	}

	@Override
	protected void body(GuiGraphicsExtractor g, int x, int top, int w, int bottom, int mx, int my) {
		int cw = Math.min(420, w - 24);
		int cx = x + (w - cw) / 2;
		int y = top + 10;
		String have = style.hasParts() ? "It has " + style.parts().size() + " parts now; Claude redrafts them." : "It has no parts of its own yet.";
		String[] lines = {
			"Claude drafts the parts of " + style.name() + ": a window, a door surround, a lantern post, roof trim and a chimney, in its own materials "
				+ "and look. " + have,
			outcome(),
			"Its roles, look, tags and owner stay. With parts, a design can use them (\"Use this style's parts\" in the Style section); "
				+ "without, it gets the Style's materials and look as guidance."};
		for (String para : lines) {
			for (String l : TextUtil.wrapPlain(font, para, cw)) {
				g.text(font, l, cx, y, UiStyle.CLAY_DARK, false);
				y += 10;
			}
			y += 4;
		}
		for (String l : TextUtil.wrapPlain(font, costLine(), cw)) {
			g.text(font, l, cx, y, UiStyle.color("palette.ui.teal_text", 0xFF1E7472), false);
			y += 10;
		}
		int by = Math.min(bottom - 8 - Button.H, y + 10);
		String why = refusal();
		go.disabled(why != null || sending).tooltip(why);
		int dw = go.width(font);
		go.draw(g, font, cx + cw - dw, by, dw, Button.H, mx, my);
		int nw = cancel.width(font);
		cancel.draw(g, font, cx + cw - dw - 6 - nw, by, nw, Button.H, mx, my);
		control("draft", go);
		control("cancel", cancel);
		String st = status != null ? status : why;
		if (st != null) {
			g.text(font, TextUtil.ellipsize(font, st, cw - dw - nw - 16), cx, by + 6, statusError || status == null ? UiStyle.error() : UiStyle.ok(), false);
		}
	}

	@Override
	protected boolean ctrlEnter() {
		if (!go.isDisabled()) {
			send();
		}
		return true;
	}

	/** Sends {@code bible.parts {bibleId, version}}; on an ack: back to the browser, the job running. */
	void send() {
		if (sending || refusal() != null) {
			return;
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "bible.parts");
		m.addProperty("bibleId", style.id());
		m.addProperty("version", style.version());
		sending = true;
		status = "Sending…";
		statusError = false;
		Sidecar.link().send(m).whenComplete((ack, err) -> minecraft.execute(() -> {
			sending = false;
			if (err != null || !ack.ok()) {
				status = "Not started: " + (err != null ? err.getMessage() : ack.error());
				statusError = true;
				return;
			}
			JsonObject r = ack.result();
			String job = r != null && r.has("jobId") ? r.get("jobId").getAsString() : "?";
			String target = r != null && r.has("bibleId") ? r.get("bibleId").getAsString() : style.id();
			lastJob = job;
			dev.larattalabs.architect.client.library.LibraryFeature.say("Claude is drafting parts for " + style.name() + " (" + job + ", " + target
				+ "): the Designs tab shows it", false);
			back();
		}));
	}

	@Override
	JsonObject stateJson() {
		JsonObject o = new JsonObject();
		o.addProperty("screen", "add_parts");
		o.addProperty("style", style.id());
		o.addProperty("version", style.version());
		o.addProperty("parts", style.parts().size());
		o.addProperty("outcome", outcome());
		o.addProperty("cost", costLine());
		o.addProperty("refusal", refusal());
		o.addProperty("status", status);
		o.addProperty("lastJob", lastJob);
		o.add("controls", controlsJson());
		return o;
	}

	static List<String> ids() {
		return List.of("draft", "cancel", "back");
	}
}
