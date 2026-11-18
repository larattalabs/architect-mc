package dev.larattalabs.architect.api;

import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (8b CK, feature {@code "connectorCheck"}) The dry-run answer of {@link Sites#checkConnector}: whether the connector fits, and its survival
 * quote. Nothing is written, reserved or consumed. Since 1.69.0.
 *
 * @param fits the plan builds it ({@code fits} or {@code adjusted}) and, with a {@code maxBill}, its quote is within the cap: a
 *             {@link Sites#placeConnector} of the same request would not refuse on the check or the cap
 * @param refusal why not, typed ({@link Reason#NO_LINK} with the kit's code, {@link Reason#BILL_CAP}, {@link Reason#FIELD_LIMIT}, ...); null
 *                when it fits
 * @param quote the survival bill ({@link Quote}, as {@link Regions#quoteApproved}); null in creative or when it does not fit
 * @param claim the claim round the two ends
 * @param ends the two ends
 * @param say one English line, display only
 */
public record ConnectorCheck(boolean fits, @Nullable Refusal refusal, @Nullable Quote quote, BoundingBox claim, List<BlockPos> ends, String say) {
	public ConnectorCheck {
		ends = List.copyOf(ends);
		say = say == null ? "" : say;
	}
}
