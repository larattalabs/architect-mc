package dev.larattalabs.architect.client.placement;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.dev.DevBridge;
import dev.larattalabs.architect.client.hud.Keys;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.site.PlayerRemove;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.labui.client.hud.Toasts;
import dev.larattalabs.labui.ui.ConfirmArm;
import dev.larattalabs.labui.ui.Guard;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;
import net.minecraft.util.Util;
import org.jspecify.annotations.Nullable;

/**
 * SAFETY: the "Undo last placement" key ({@link Keys#undoLast}, Z by default). The first press finds the newest site this
 * player placed this session that is still theirs ({@link PlayerRemove#latestOwn}: never a site a mod owns, never one placed
 * through the API) and arms a lab-ui {@link ConfirmArm} for {@value #WINDOW_MS} ms with a toast and an action-bar countdown; a
 * second press within the window removes it through the same path as Library &gt; Placed &gt; Remove ({@link
 * PlayerRemove#remove}). Ignored while placing, marking a plot or with a screen open.
 */
public final class UndoLastKey {
	static final long WINDOW_MS = 5_000;
	private static final ConfirmArm ARM = new ConfirmArm(WINDOW_MS);
	private static final String KEY = "undo:";
	/** A server round trip is in flight: further presses wait for it. */
	private static boolean busy;
	private static @Nullable String armedSite;
	private static @Nullable String armedName;
	private static int shownSeconds = -1;
	private static @Nullable String lastMessage;

	private UndoLastKey() {
	}

	static void init() {
		Keys.ensureRegistered();
		ClientTickEvents.END_CLIENT_TICK.register(mc -> Guard.run("architect_mc:undo_last.key", () -> tick(mc)));
		DevBridge.register("dev.safety.undo", 10_000, "{} - (SAFETY) the Undo last placement key's state: {key, armedSite, secondsLeft, busy, "
			+ "lastMessage, latest (the site the key would undo now, or null)}", (req, mc) -> DevBridge.onClient(mc, () -> mc.player)
				.thenCompose(p -> p == null ? java.util.concurrent.CompletableFuture.completedFuture(null) : ServerTasks.callAsPlayer((level, player) -> {
					Site s = PlayerRemove.latestOwn(player.getUUID().toString());
					return s == null ? null : s.id();
				})).thenCompose(latest -> DevBridge.onClient(mc, () -> {
					JsonObject o = json();
					o.addProperty("latest", latest);
					return o;
				})));
	}

	static JsonObject json() {
		JsonObject o = new JsonObject();
		long now = Util.getMillis();
		o.addProperty("key", Keys.undoLast == null ? null : Keys.label(Keys.undoLast));
		String armed = ARM.armedKey(now);
		o.addProperty("armedSite", armed == null ? null : armedSite);
		o.addProperty("secondsLeft", ARM.secondsLeft(now));
		o.addProperty("busy", busy);
		o.addProperty("lastMessage", lastMessage);
		return o;
	}

	private static void tick(Minecraft mc) {
		while (Keys.undoLast.consumeClick()) {
			press(mc);
		}
		// the countdown in the action bar while armed
		long now = Util.getMillis();
		if (ARM.armedKey(now) != null && mc.player != null) {
			int sec = ARM.secondsLeft(now);
			if (sec != shownSeconds) {
				shownSeconds = sec;
				mc.gui.hud.setOverlayMessage(Component.literal("Press " + Keys.label(Keys.undoLast) + " again to remove " + armedSite + " (" + armedName
					+ ") (" + sec + ")"), false);
			}
		} else if (shownSeconds >= 0) {
			shownSeconds = -1;
			armedSite = null;
		}
	}

	private static void press(Minecraft mc) {
		if (mc.player == null || mc.gui.screen() != null || BuildPlacement.active() || PlotMarker.active() || busy) {
			return;
		}
		busy = true;
		// what the key would undo now (asked again on the second press: a site placed meanwhile becomes the target, re-armed)
		ServerTasks.callAsPlayer((level, player) -> {
			Site s = PlayerRemove.latestOwn(player.getUUID().toString());
			if (s == null) {
				return null;
			}
			Blueprint bp = Blueprints.get(s.blueprint());
			return new String[] {s.id(), bp == null ? s.blueprint() : bp.name()};
		}).whenComplete((found, err) -> {
			busy = false;
			if (err != null) {
				say(Toasts.Level.WARN, "Undo last placement", "Could not check: " + err.getMessage());
				return;
			}
			if (found == null) {
				ARM.cancel();
				say(Toasts.Level.INFO, "Nothing to undo", "No site you placed in this session is still standing as yours");
				return;
			}
			String id = found[0];
			var r = ARM.pressByKey(KEY + id, Util.getMillis(), false);
			if (r == ConfirmArm.Result.ARMED) {
				armedSite = id;
				armedName = found[1];
				shownSeconds = -1;
				String k = Keys.label(Keys.undoLast);
				lastMessage = "Press " + k + " again within " + WINDOW_MS / 1000 + " s to remove " + id + " (" + found[1] + "); the ground comes back";
				Toasts.push(Toasts.Spec.of(Toasts.Level.NEED, "Undo last placement?", "Remove " + id + " (" + found[1] + "); the ground comes back")
					.hint(k, "again to undo"));
			} else if (r == ConfirmArm.Result.CONFIRMED) {
				remove(id);
			}
		});
	}

	/** The second press: the same removal as Library &gt; Placed &gt; Remove, after checking it is still the player's latest own. */
	private static void remove(String id) {
		busy = true;
		ServerTasks.callAsPlayer((level, player) -> {
			Site s = PlayerRemove.latestOwn(player.getUUID().toString());
			if (s == null || !s.id().equals(id)) {
				return "!" + id + " is no longer your latest placement: nothing was removed (press again to see what would be)";
			}
			String m = PlayerRemove.remove(level, s, false, null);
			if (m.startsWith("?")) {
				return "!" + m.substring(1) + ". Choose in Library > Placed (Remove keeps them, Remove both takes both)";
			}
			return m;
		}).whenComplete((msg, err) -> {
			busy = false;
			armedSite = null;
			Minecraft.getInstance().gui.hud.setOverlayMessage(Component.empty(), false);
			String m = err != null ? "!" + err.getMessage() : msg;
			boolean bad = m.startsWith("!");
			lastMessage = bad ? m.substring(1) : m;
			say(bad ? Toasts.Level.WARN : Toasts.Level.INFO, bad ? "Not undone" : "Undone", lastMessage);
		});
	}

	private static void say(Toasts.Level level, String title, String body) {
		lastMessage = body;
		Toasts.push(Toasts.Spec.of(level, title, body));
	}
}
