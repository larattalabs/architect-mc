package dev.larattalabs.architect.api;

import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;

/**
 * The world's survival toggle (docs/CONTRACT.md phase 3 "The toggle"; Steward's ask, since 1.2.0): whether placement makes
 * construction sites, and how fast they build. {@link Sites#survival()} and {@link SiteEvents#WORLD_MODE_CHANGED}.
 *
 * @param enabled construction sites are on in this world ({@link Mode#AUTO} places a construction site)
 * @param blocksPerTick how many cells a construction site builds per tick at most (1-64)
 */
public record SurvivalInfo(boolean enabled, int blocksPerTick) {
	/**
	 * Whether {@code actor} may change the toggle ({@code /architect survival on|off}, the Status tab): permission level 2
	 * (cheats on, or an operator). A null actor (a mod on its own) may not.
	 */
	public boolean mayToggle(@Nullable ServerPlayer actor) {
		return actor != null && actor.createCommandSourceStack().permissions().hasPermission(
			net.minecraft.server.permissions.Permissions.COMMANDS_GAMEMASTER);
	}
}
