package dev.larattalabs.architect.survival;

import com.mojang.serialization.Codec;
import dev.larattalabs.architect.site.Builder;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.WorldlyContainer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.ValueInput;
import net.minecraft.world.level.storage.ValueOutput;
import org.jspecify.annotations.Nullable;

/**
 * The construction crate's block entity (docs/CONTRACT.md phase 3 "The crate"): a {@link WorldlyContainer} with one input
 * slot that is always empty, so hoppers and droppers insert from any side and never jam: an item goes in only while the site
 * still needs it (counting equivalents, converted on insert) and is booked into the {@link Ledger} at once. Nothing can be
 * taken out. The ledger (delivered / placed per item, the stock with its credit) is saved with the chunk, so items and
 * ledger can't drift apart in a crash.
 */
public final class CrateBlockEntity extends BlockEntity implements WorldlyContainer {
	private static final int[] SLOTS = {0};
	private static final Codec<Map<String, Integer>> COUNTS = Codec.unboundedMap(Codec.STRING, Codec.INT);

	private String siteId = "";
	private final Ledger ledger = new Ledger();

	public CrateBlockEntity(BlockPos pos, BlockState state) {
		super(CrateBlocks.CRATE_ENTITY, pos, state);
	}

	public String siteId() {
		return siteId;
	}

	public void setSiteId(String id) {
		siteId = id;
		setChanged();
	}

	public Ledger ledger() {
		return ledger;
	}

	/** After the builder or an insert changed the ledger. */
	public void ledgerChanged() {
		setChanged();
	}

	static String itemId(ItemStack stack) {
		return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
	}

	/** Whether one unit of {@code stack} would go in. Server side only (false on the client). */
	public boolean wouldAccept(ItemStack stack) {
		return !stack.isEmpty() && level != null && !level.isClientSide() && Builder.accepts(siteId, this, itemId(stack), false) != null;
	}

	/**
	 * Books as much of {@code stack} as the site needs, one unit at a time, and shrinks the stack by what went in. Returns
	 * the units taken. Server thread.
	 */
	public int insert(ItemStack stack) {
		if (stack.isEmpty() || level == null || level.isClientSide()) {
			return 0;
		}
		String item = itemId(stack);
		int n = 0;
		while (!stack.isEmpty() && Builder.accepts(siteId, this, item, true) != null) {
			stack.shrink(1);
			n++;
		}
		if (n > 0) {
			setChanged();
			Builder.delivered(siteId);
		}
		return n;
	}

	// ------------------------------------------------------------------ WorldlyContainer: one input slot, always empty

	@Override
	public int[] getSlotsForFace(Direction direction) {
		return SLOTS;
	}

	@Override
	public boolean canPlaceItemThroughFace(int slot, ItemStack stack, @Nullable Direction direction) {
		return wouldAccept(stack);
	}

	@Override
	public boolean canTakeItemThroughFace(int slot, ItemStack stack, Direction direction) {
		return false;
	}

	@Override
	public boolean canPlaceItem(int slot, ItemStack stack) {
		return wouldAccept(stack);
	}

	@Override
	public int getContainerSize() {
		return 1;
	}

	@Override
	public boolean isEmpty() {
		return true;
	}

	@Override
	public ItemStack getItem(int slot) {
		return ItemStack.EMPTY;
	}

	@Override
	public ItemStack removeItem(int slot, int count) {
		return ItemStack.EMPTY;
	}

	@Override
	public ItemStack removeItemNoUpdate(int slot) {
		return ItemStack.EMPTY;
	}

	@Override
	public void setItem(int slot, ItemStack stack) {
		// a hopper or dropper hands over what canPlaceItem accepted (one item): book it; anything refused is lost only if the
		// caller ignored canPlaceItem, which vanilla never does
		insert(stack.copy());
	}

	@Override
	public boolean stillValid(Player player) {
		return false;
	}

	@Override
	public void clearContent() {
	}

	// ------------------------------------------------------------------ persistence

	@Override
	protected void saveAdditional(ValueOutput output) {
		super.saveAdditional(output);
		output.putString("Site", siteId);
		output.store("Delivered", COUNTS, ledger.delivered());
		output.store("Placed", COUNTS, ledger.placed());
	}

	@Override
	protected void loadAdditional(ValueInput input) {
		super.loadAdditional(input);
		siteId = input.getStringOr("Site", "");
		ledger.load(input.read("Delivered", COUNTS).orElse(Map.of()), input.read("Placed", COUNTS).orElse(Map.of()));
	}
}
