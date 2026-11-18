package dev.larattalabs.architect.client.api;

import dev.larattalabs.architect.api.ArchitectClientApi;
import dev.larattalabs.architect.api.PreviewLayer;
import dev.larattalabs.architect.api.PreviewStyle;
import dev.larattalabs.architect.client.placement.BuildPlacement;
import dev.larattalabs.architect.client.placement.CompositePreview;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;

/** {@link ArchitectClientApi} over {@link BuildPlacement}'s preview mode and {@link CompositePreview}. Internal. */
public final class ClientApiImpl implements ArchitectClientApi {
	public static final ClientApiImpl INSTANCE = new ClientApiImpl();

	private ClientApiImpl() {
	}

	@Override
	public void preview(String blueprintId, BlockPos origin, Rotation rotation, PreviewStyle style) {
		BuildPlacement.startPreview(blueprintId, origin.getX(), origin.getY(), origin.getZ(), rotation == null ? 0 : rotation.ordinal());
	}

	@Override
	public void clearPreview() {
		if (BuildPlacement.preview()) {
			BuildPlacement.cancel();
		}
	}

	@Override
	public boolean previewing() {
		return BuildPlacement.preview();
	}

	@Override
	public void previewComposite(String key, List<PreviewLayer> layers) {
		CompositePreview.show(key, layers == null ? List.of() : layers);
	}

	@Override
	public void clearComposite(String key) {
		CompositePreview.clear(key);
	}

	@Override
	public Set<String> compositeKeys() {
		return CompositePreview.keys();
	}

	@Override
	public void previewDelta(String key, String siteId, int toVersion) {
		if (key == null || key.isBlank()) {
			throw new IllegalArgumentException("a composite needs a key");
		}
		dev.larattalabs.architect.client.placement.DeltaGhost.request(key, siteId, toVersion);
	}

	@Override
	public void previewRegion(String planId, @org.jspecify.annotations.Nullable String stage) {
		if (planId == null || planId.isBlank()) {
			throw new IllegalArgumentException("previewRegion needs a plan id");
		}
		dev.larattalabs.architect.client.placement.RegionGhost.show(planId, stage);
	}

	/** (8b CK) The plot marker's connector mode, mark-only. */
	@Override
	public void markConnector(String kind, net.minecraft.core.@org.jspecify.annotations.Nullable BlockPos firstEnd,
		java.util.function.Consumer<dev.larattalabs.architect.api.@org.jspecify.annotations.Nullable MarkedLink> done) {
		if (kind == null || done == null) {
			throw new IllegalArgumentException("markConnector needs a kind and a callback");
		}
		dev.larattalabs.architect.client.placement.PlotMarker.startMarkConnector(kind.toLowerCase(java.util.Locale.ROOT), firstEnd == null ? null : new int[] {
			firstEnd.getX(), firstEnd.getY(), firstEnd.getZ()}, done);
	}

	@Override
	public void clearRegionPreview() {
		dev.larattalabs.architect.client.placement.RegionGhost.hide();
	}
}
