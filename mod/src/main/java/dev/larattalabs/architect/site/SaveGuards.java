package dev.larattalabs.architect.site;

import java.util.LinkedHashMap;
import java.util.Map;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;

/**
 * (Slice PS, audit F6) The status line for a world file that could not be loaded ({@code stockpiles.json}, {@code architect-queue.json}):
 * the file is kept as it is (nothing saved over it this session), and each player who joins is told so in chat, with the file and the
 * way back (fix it, or restore its {@code .bak}, and reopen the world). Server thread.
 */
public final class SaveGuards {
	private static final Map<String, String> FAILED = new LinkedHashMap<>();
	private static boolean registered;

	private SaveGuards() {
	}

	static synchronized void init() {
		if (registered) {
			return;
		}
		registered = true;
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> server.execute(() -> {
			for (Component line : lines()) {
				handler.getPlayer().sendSystemMessage(line);
			}
		}));
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> clear());
	}

	/** A file failed to load this session (it is not saved over). */
	static synchronized void failed(String file, String why) {
		FAILED.put(file, why);
	}

	static synchronized void clear() {
		FAILED.clear();
	}

	/** The failures this session: file to why (dev, tests). */
	public static synchronized Map<String, String> failures() {
		return Map.copyOf(FAILED);
	}

	/** The chat lines a joining player gets (empty when every file loaded). */
	static synchronized java.util.List<Component> lines() {
		java.util.List<Component> out = new java.util.ArrayList<>();
		FAILED.forEach((file, why) -> out.add(Component.literal("[Architect] " + file + " could not be loaded (" + why + "). It is kept as it is and "
			+ "not saved this session: fix it, or restore " + file + ".bak, and reopen the world.").withStyle(ChatFormatting.RED)));
		return out;
	}
}
