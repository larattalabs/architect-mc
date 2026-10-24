package dev.larattalabs.architect.client.screen;

import dev.larattalabs.architect.client.design.MassingReview;
import dev.larattalabs.labui.client.hud.UiBits;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.client.ui.UiStyle;
import dev.larattalabs.labui.client.widget.Button;
import dev.larattalabs.labui.client.widget.Paint;
import java.util.List;
import net.minecraft.client.gui.GuiGraphicsExtractor;

/**
 * (Style unification U3) The Library's jobs strip: what is being made right now (the newest job and its step, how many more) with a way
 * to the Designs tab, and a massing on review with Approve / Redirect… / Put aside by mouse (the same as the review bar's Enter / R /
 * Backspace). Hidden when nothing runs. Client thread.
 */
final class JobStrip {
	static final int H = Button.H + 4;

	private JobStrip() {
	}

	static List<ArchitectScreen.Job> running() {
		return ArchitectScreen.jobs().stream().filter(ArchitectScreen.Job::running).toList();
	}

	static int height() {
		return MassingReview.review() != null || !running().isEmpty() ? H : 0;
	}

	static void draw(ArchitectScreen s, GuiGraphicsExtractor g, int x, int y, int w, int mx, int my) {
		var font = s.font();
		MassingReview.Review r = MassingReview.review();
		Paint.box(g, x, y, w, H, r != null ? 0xFFF1E3B6 : UiStyle.withAlpha(UiStyle.PAPER, 255), r != null ? 0xFFD9C27A : UiStyle.rule());
		int bx = x + w - 2;
		if (r != null) {
			String[][] bs = {{"jobs:aside", "Put aside"}, {"jobs:redirect", "Redirect…"}, {"jobs:approve", "Approve"}};
			for (String[] b : bs) {
				int bw = Button.width(font, b[1]);
				bx -= bw;
				Button bt = new Button(b[1], switch (b[0]) {
					case "jobs:approve" -> (Runnable) MassingReview::approve;
					case "jobs:redirect" -> () -> {
						s.onClose();
						MassingReview.redirectDialog();
					};
					default -> MassingReview::cancel;
				}).primary(b[0].equals("jobs:approve"));
				bt.draw(g, font, bx, y + 2, bw, Button.H, mx, my);
				s.control(b[0], b[1], bt, false);
				bx -= 4;
			}
			String t = "Massing ready: " + r.title() + " v" + r.massing().version() + " (" + r.massing().parts().size() + " masses, standing in the world)";
			g.text(font, TextUtil.ellipsize(font, t, bx - x - 8), x + 5, y + 7, 0xFF6B5420, false);
			return;
		}
		List<ArchitectScreen.Job> run = running();
		if (run.isEmpty()) {
			return;
		}
		String open = "Designs tab";
		int ow = Button.width(font, open);
		bx -= ow;
		Button ob = new Button(open, () -> {
			s.showJob(run.get(0).id());
			s.setTab(ArchitectScreen.Tab.DESIGNS);
		});
		ob.draw(g, font, bx, y + 2, ow, Button.H, mx, my);
		s.control("jobs:open", open, ob, false);
		ArchitectScreen.Job j = run.get(0);
		UiBits.dotPill(g, font, j.fam(), j.kind(), x + 4, y + 5, UiBits.ink());
		int tx = x + 8 + UiBits.dotPillWidth(font, j.kind());
		String t = j.title() + " · " + j.status() + (j.step() == null || j.step().isBlank() ? "" : ": " + j.step()) + (run.size() > 1 ? " · " + (run.size()
			- 1) + " more" : "");
		g.text(font, TextUtil.ellipsize(font, t, bx - tx - 6), tx, y + 7, UiBits.ink(), false);
	}
}
