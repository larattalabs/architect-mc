package dev.larattalabs.architect.api;

import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;

/**
 * How {@link Sites#fitToLot} fits a design to a lot. Since 1.4.0.
 *
 * @param centreOn across the street: {@link CentreOn#ENTRANCE} centres the entrance column on the lot's street-side span (the
 *                 default), {@link CentreOn#BOX} centres the footprint. An entrance-centred box that would stick out of the
 *                 lot sideways is moved back inside it (the entrance as near the centre as the lot allows).
 * @param setback how far the front face sits back from the lot's street edge; null = the approach length, so the approach
 *                ends on the lot edge and stays inside the lot
 * @param approachIntoStreet the front face on the lot edge (setback 0), the approach running out into the street
 * @param level where the verdict is checked (null: the overworld)
 * @param mode and {@code force}, {@code actor}: as in a {@link PlaceRequest}, for the verdict
 */
public record FitOptions(CentreOn centreOn, @Nullable Integer setback, boolean approachIntoStreet, @Nullable ServerLevel level, Mode mode, boolean force,
	@Nullable ServerPlayer actor) {
	public static final FitOptions DEFAULT = new FitOptions(CentreOn.ENTRANCE, null, false, null, Mode.AUTO, false, null);

	public FitOptions {
		centreOn = centreOn == null ? CentreOn.ENTRANCE : centreOn;
		mode = mode == null ? Mode.AUTO : mode;
		if (setback != null && setback < 0) {
			throw new IllegalArgumentException("setback must be >= 0");
		}
	}

	public FitOptions withLevel(@Nullable ServerLevel l) {
		return new FitOptions(centreOn, setback, approachIntoStreet, l, mode, force, actor);
	}

	public FitOptions withApproachIntoStreet(boolean into) {
		return new FitOptions(centreOn, setback, into, level, mode, force, actor);
	}

	public FitOptions withCentreOn(CentreOn c) {
		return new FitOptions(c, setback, approachIntoStreet, level, mode, force, actor);
	}

	public FitOptions withSetback(@Nullable Integer s) {
		return new FitOptions(centreOn, s, approachIntoStreet, level, mode, force, actor);
	}

	/** What is centred on the lot's street-side span. */
	public enum CentreOn {
		ENTRANCE, BOX
	}
}
