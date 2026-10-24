package dev.larattalabs.architect.client.screen;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Estimate;
import dev.larattalabs.architect.client.design.SetFeature;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.labui.client.text.TextModel;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.client.ui.UiStyle;
import dev.larattalabs.labui.client.widget.Button;
import java.util.List;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import org.jspecify.annotations.Nullable;

/**
 * (Style unification U3) "+ New style › Describe it": the player describes a Style and Claude drafts it as a bible job ({@code bible
 * .request}, the paid path; the sim helper drafts a fixed one at $0). The screen shows the job's cost line (the helper's {@code
 * bible.estimate}) before anything is sent. When the job is done the Style is under "Made by Claude". Client thread.
 */
final class DescribeStyleScreen extends U3Screen {
	/** The contract's ballpark for a bible job, until the helper answers. */
	static final String SEED_COST = "about $0.30-1.20, 3-8 min (Claude drafts the roles, components and a sample sheet)";
	private static volatile @Nullable Estimate estimate;
	private static volatile boolean asked;

	private final TextModel name = new TextModel(40);
	private final TextModel prompt = new TextModel(2000);
	private final Field nameField;
	private final Field promptField;
	private final Button draft = new Button("Draft it", this::send).primary(true);
	private final Button cancel = new Button("Cancel", this::back);
	private @Nullable String status;
	private boolean statusError;
	private boolean sending;

	DescribeStyleScreen(@Nullable Screen parent) {
		super("Describe a style", parent);
		nameField = field("name", name, "a name, e.g. Harbour stone (optional)", 1);
		promptField = field("prompt", prompt, "what it looks like, e.g. weathered fishing village on stilts, grey stone, teal shutters", 4);
		focus(promptField);
		askEstimate();
	}

	/** "about $0.30-1.20, 3-8 min": the helper's bible.estimate once it answered, else the ballpark. */
	static String costLine() {
		Estimate e = estimate;
		askEstimate();
		return e == null ? SEED_COST : "Claude drafts it: " + dev.larattalabs.architect.design.CritiqueRules.estimateLine(e);
	}

	private static void askEstimate() {
		if (asked || !Sidecar.connected() || !SetFeature.has("bibles")) {
			return;
		}
		asked = true;
		JsonObject m = new JsonObject();
		m.addProperty("type", "bible.estimate");
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

	@Override
	protected String title() {
		return "Describe a style · Claude drafts it";
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
		g.text(font, "Name", cx, y, UiStyle.CLAY_DARK, false);
		y += 11;
		y += drawField(g, nameField, cx, y, cw) + 6;
		g.text(font, "What should it look like?", cx, y, UiStyle.CLAY_DARK, false);
		y += 11;
		y += drawField(g, promptField, cx, y, cw) + 6;
		for (String l : TextUtil.wrapPlain(font, costLine(), cw)) {
			g.text(font, l, cx, y, UiStyle.color("palette.ui.teal_text", 0xFF1E7472), false);
			y += 10;
		}
		for (String l : TextUtil.wrapPlain(font, "When it is done it is yours, under Made by Claude: use it, duplicate it or edit it. The Designs tab shows the job.", cw)) {
			g.text(font, l, cx, y, UiStyle.mutedText(), false);
			y += 10;
		}
		int by = Math.min(bottom - 8 - Button.H, y + 10);
		String why = !Sidecar.connected() ? "The design helper is not running (Status tab)." : !SetFeature.has("bibles")
			? "This design helper doesn't make Styles (needs phase 4b)." : prompt.value().isBlank() ? "Describe it first." : null;
		draft.disabled(why != null || sending).tooltip(why);
		int dw = draft.width(font);
		draft.draw(g, font, cx + cw - dw, by, dw, Button.H, mx, my);
		int nw = cancel.width(font);
		cancel.draw(g, font, cx + cw - dw - 6 - nw, by, nw, Button.H, mx, my);
		control("draft", draft);
		control("cancel", cancel);
		String st = status != null ? status : why;
		if (st != null) {
			g.text(font, TextUtil.ellipsize(font, st, cw - dw - nw - 16), cx, by + 6, statusError || status == null ? UiStyle.error() : UiStyle.ok(), false);
		}
	}

	@Override
	protected boolean ctrlEnter() {
		if (!draft.isDisabled()) {
			send();
		}
		return true;
	}

	/** Sends {@code bible.request {prompt, name?}}; on an ack: back to the browser, the job running. */
	void send() {
		if (prompt.value().isBlank() || sending) {
			return;
		}
		JsonObject r = new JsonObject();
		r.addProperty("prompt", prompt.value().strip());
		if (!name.value().isBlank()) {
			r.addProperty("name", name.value().strip());
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "bible.request");
		m.add("request", r);
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
			String job = ack.result() != null && ack.result().has("jobId") ? ack.result().get("jobId").getAsString() : "?";
			lastJob = job;
			dev.larattalabs.architect.client.library.LibraryFeature.say("Claude is drafting " + (name.value().isBlank() ? "your Style" : name.value()
				.strip()) + " (" + job + "): the Designs tab shows it; it appears under Made by Claude when done", false);
			back();
		}));
	}

	static volatile @Nullable String lastJob;

	void fill(@Nullable String n, @Nullable String p) {
		if (n != null) {
			name.set(n);
		}
		if (p != null) {
			prompt.set(p);
		}
	}

	@Override
	JsonObject stateJson() {
		JsonObject o = new JsonObject();
		o.addProperty("screen", "describe_style");
		o.addProperty("name", name.value());
		o.addProperty("prompt", prompt.value());
		o.addProperty("cost", costLine());
		o.addProperty("status", status);
		o.addProperty("lastJob", lastJob);
		o.add("controls", controlsJson());
		return o;
	}

	static List<String> ids() {
		return List.of("draft", "cancel", "back");
	}
}
