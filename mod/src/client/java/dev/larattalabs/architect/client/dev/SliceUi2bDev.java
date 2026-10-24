package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.design.UiPrefs;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;

/**
 * Slice UI-2b DevBridge hooks (docs/DEVBRIDGE.md): a command's chat output with its links (the pagers' [‹ prev] / [next ›], reload's
 * [show], did-you-mean's ids), the GUI scale for the HUD shots, the construction HUD's mode, the toasts, and a preview of the helper's
 * progress strip (which shows only during a real install or first start). Client only; no world state changes.
 */
public final class SliceUi2bDev {
	private SliceUi2bDev() {
	}

	public static void init() {
		DevBridge.register("dev.ui2b.command", 30_000, "{cmd, asPlayer?: true} - (UI-2b) run a command and return its chat output as components: "
			+ "{messages: [{text, parts: [{text, click?, value?, hover?}], links: [{text, click, value}]}], success, result}", (req, mc) -> {
				Fields f = Fields.of(req);
				String cmd = f.nonBlank("cmd");
				boolean asPlayer = f.optBool("asPlayer", true);
				return DevBridge.onClient(mc, () -> new Object[] {DevCommands.needServer(mc), mc.player.getUUID()}).thenCompose(arr -> {
					var server = (net.minecraft.client.server.IntegratedServer) arr[0];
					UUID uuid = (UUID) arr[1];
					return server.submit(() -> {
						ServerPlayer sp = server.getPlayerList().getPlayer(uuid);
						List<Component> messages = new ArrayList<>();
						AtomicBoolean success = new AtomicBoolean(true);
						AtomicInteger result = new AtomicInteger(0);
						CommandSource capture = new CommandSource() {
							@Override
							public void sendSystemMessage(Component message) {
								messages.add(message);
							}

							@Override
							public boolean acceptsSuccess() {
								return true;
							}

							@Override
							public boolean acceptsFailure() {
								return true;
							}

							@Override
							public boolean shouldInformAdmins() {
								return false;
							}
						};
						CommandSourceStack base = sp != null ? sp.createCommandSourceStack() : server.createCommandSourceStack();
						CommandSourceStack source = (asPlayer ? base.withSource(capture) : base.withSource(capture).withPermission(
							net.minecraft.server.permissions.LevelBasedPermissionSet.OWNER)).withCallback((ok, value) -> {
								if (!ok) {
									success.set(false);
								}
								result.set(value);
							});
						server.getCommands().performPrefixedCommand(source, cmd);
						JsonObject o = new JsonObject();
						o.addProperty("cmd", cmd);
						JsonArray arrMsgs = new JsonArray();
						for (Component c : messages) {
							arrMsgs.add(ChatJson.of(c));
						}
						o.add("messages", arrMsgs);
						o.addProperty("success", success.get());
						o.addProperty("result", result.get());
						return o;
					});
				});
			});
		DevBridge.register("dev.gui.scale", 10_000, "{scale: 0 (auto) - 6} - (UI-2b) set the GUI scale as Options > Video Settings does -> {guiScale, "
			+ "guiWidth, guiHeight}", (req, mc) -> {
				int scale = Fields.of(req).optInt("scale", 0, 0, 6);
				return DevBridge.onClient(mc, () -> {
					mc.options.guiScale().set(scale);
					mc.resizeGui();
					JsonObject o = new JsonObject();
					o.addProperty("guiScale", mc.getWindow().getGuiScale());
					o.addProperty("guiWidth", mc.getWindow().getGuiScaledWidth());
					o.addProperty("guiHeight", mc.getWindow().getGuiScaledHeight());
					return o;
				});
			});
		DevBridge.register("dev.ui2b.siteHud", 10_000, "{mode?: full|line|hidden} - (UI-2b) the construction HUD's mode (as the J key) -> {mode}",
			(req, mc) -> {
				String m = Fields.of(req).optStr("mode", null);
				return DevBridge.onClient(mc, () -> {
					if (m != null) {
						UiPrefs.SiteHud mode = null;
						for (UiPrefs.SiteHud x : UiPrefs.SiteHud.values()) {
							if (x.id().equalsIgnoreCase(m)) {
								mode = x;
							}
						}
						if (mode == null) {
							throw new DevBridge.DevException("mode must be full, line or hidden");
						}
						UiPrefs.setSiteHud(mode);
					}
					JsonObject o = new JsonObject();
					o.addProperty("mode", UiPrefs.siteHud().id());
					return o;
				});
			});
		DevBridge.register("dev.ui2b.toasts", 10_000, "{} - (UI-2b) the toast stack (lab-ui Toasts.json)", (req, mc) -> DevBridge.onClient(mc,
			dev.larattalabs.labui.client.hud.Toasts::json));
		DevBridge.register("dev.ui2b.helperPreview", 10_000, "{label?: string|null, npm?: string} - (UI-2b) draw the helper's progress strip with this "
			+ "label (null: back to the real state), for a screenshot", (req, mc) -> {
				Fields f = Fields.of(req);
				String label = f.optStr("label", null);
				String npm = f.optStr("npm", null);
				return DevBridge.onClient(mc, () -> {
					dev.larattalabs.architect.client.launcher.HelperProgressHud.preview(label, npm);
					JsonObject o = new JsonObject();
					o.addProperty("preview", label);
					return o;
				});
			});
	}
}
