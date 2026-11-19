package dev.larattalabs.architect.client.screen;

import dev.larattalabs.labui.ui.TextScale;
import java.util.function.BooleanSupplier;
import net.minecraft.client.gui.screens.Screen;

/**
 * (PR2) Input handlers of a text-scaled screen measure text as it is drawn. The screens draw inside {@code TextScaleHost.render}, so
 * {@code font.width}, wrapping and {@code TextFieldView.hit} run at the text size there; a click or a caret move that measured at 100 %
 * picked a later character than the one under the pointer and other line breaks. Each opted-in screen's mouse and key handlers run
 * through {@link #in}, with the same scale its draw uses.
 */
public final class ScaledInput {
	/** The owner id Architect's screens opt in under. */
	public static final String OWNER = "architect_mc";

	private ScaledInput() {
	}

	/** Runs {@code body} with {@code s}'s text scale active (the one its draw uses), then restores the previous scale. */
	public static boolean in(Screen s, BooleanSupplier body) {
		return at(TextScale.resolve(OWNER, s.width, s.height).factor(), body);
	}

	/** Runs {@code body} with text measured at {@code factor}, restoring the previous factor after, also on a throw. */
	public static boolean at(float factor, BooleanSupplier body) {
		float was = TextScale.activate(factor);
		try {
			return body.getAsBoolean();
		} finally {
			TextScale.activate(was);
		}
	}
}
