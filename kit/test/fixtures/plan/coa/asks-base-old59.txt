# 59 asks: adjusted 12, blocked 3, fits 66, refused 26, unsupported 25
# gap table (unsupported parts per block id):
  rule.shape               3
  tunnel.under             3
  connector.lift           2
  connector.stair          2
  form.crater              2
  rule.variety             2
  connector.drawbridge     1
  connector.ladder         1
  connector.rail           1
  form.floating_island     1
  form.hollow_mountain     1
  form.mast                1
  form.seabed_site         1
  form.ship_hull           1
  program.districts        1
  rule.stacked_floors      1
  rule.suspended           1
# every part:
arcology/tower_city zone.standard fits
arcology/unused_placeholder zone.standard refused NO_ROOM
arcology/stacked_floors rule.stacked_floors unsupported UNSUPPORTED until RC
around_my_house/village zone.standard fits
around_my_tree/grove zone.standard fits
boom_town/boomtown zone.standard fits
border_fort/fort zone.standard fits
border_fort/pass_road connector.road fits
border_fort/fort_wall connector.wall adjusted
border_fort/fort_relief form.relief fits
camp_to_city/camp_city zone.standard fits
camp_to_city/city_wall connector.wall adjusted
castle_city/castle zone.standard adjusted
castle_city/curtain_wall connector.wall adjusted
cat_sanctuary/sanctuary zone.standard adjusted
cliff_monks/monastery zone.standard fits
cliff_monks/sea_stair connector.path fits
cliff_monks/ledge_path connector.path fits
conquered_town/village zone.standard fits
crater_mine/mine_zone zone.standard fits
crater_mine/crater form.crater unsupported UNSUPPORTED until 7c
crater_mine/crater_relief form.relief fits
desert_jungle_wall/town zone.standard fits
desert_jungle_wall/great_wall connector.wall fits
desert_jungle_wall/two_faced_palette rule.palette refused NO_FEATURE
dwarven_hold/hold zone.standard fits
dwarven_hold/mountain_hollow form.hollow_mountain unsupported UNSUPPORTED until 7c
end_city_ruins/city zone.standard fits
end_city_ruins/dwelling_bridges connector.bridge refused NO_GAP
end_city_ruins/central_terrace form.terrace fits
falls_to_ruin/hold zone.standard fits
farm_village/hamlet zone.standard fits
fishing_village/village zone.standard fits
grid_city/grid_city zone.standard fits
harbour/harbour zone.standard fits
harvest_hamlet/hamlet zone.standard fits
hidden_village/hollow zone.standard adjusted
hidden_village/cave_ladders connector.ladder unsupported UNSUPPORTED until 7a
hidden_village/waterfall_curtain form.waterfall adjusted
hidden_village/mossy_palette rule.palette refused NO_FEATURE
ice_village/village zone.standard adjusted
lone_hermit/hermitage zone.standard fits
looks_old/hold zone.standard fits
mage_exiles/enclave zone.standard fits
mage_exiles/shared_stone_base rule.palette refused TOLERANCE
market_town/town zone.standard fits
metropolis/capital zone.standard adjusted
metropolis/city_wall connector.wall fits
mining_town/mining_town zone.standard fits
mining_town/street_1 connector.street fits
mining_town/rail_1 connector.rail unsupported UNSUPPORTED until 7a
mushroom_town/hamlet zone.standard fits
nether_outpost/outpost zone.standard fits
no_right_angles/town zone.standard fits
no_right_angles/no_right_angles rule.shape unsupported UNSUPPORTED until RC
no_two_alike/village zone.standard fits
no_two_alike/no_two_alike rule.variety unsupported UNSUPPORTED until RC
nomad_camp/camp zone.standard fits
old_new_town/town zone.standard fits
old_new_town/hill_street connector.street fits
old_new_town/quarter_stair connector.stair unsupported UNSUPPORTED until 7a
old_new_town/two_styles rule.palette refused NO_FEATURE
one_block/reach zone.standard fits
one_block/gentle_terraces form.terrace refused OVERLAP
one_block/copper_only rule.palette refused TOLERANCE
organic_hamlet/hamlet zone.standard fits
pirate_cove/cove zone.standard fits
redstone_gate/fortress zone.standard adjusted
redstone_gate/moat connector.channel fits
redstone_gate/curtain_wall connector.wall adjusted
redstone_gate/main_gate connector.gate refused NO_ROOM
redstone_gate/drawbridge connector.drawbridge unsupported UNSUPPORTED until mechanism
ring_city/ring_town zone.standard blocked DEPENDENCY
ring_city/crater_lake form.crater unsupported UNSUPPORTED until 7c
rival_families/estates zone.standard refused NO_FEATURE
rival_families/family_colours rule.palette refused NO_FEATURE
rival_families/mirrored_banks rule.shape unsupported UNSUPPORTED until RC
row_houses/row zone.standard fits
row_houses/identical_houses rule.variety unsupported UNSUPPORTED until RC
row_houses/plain_palette rule.palette refused NO_FEATURE
ruined_empire/survivors_camp zone.standard fits
secret_tunnels/cove zone.standard fits
secret_tunnels/tunnel_cellar tunnel.under unsupported UNSUPPORTED until 7b
secret_tunnels/tunnel_dock tunnel.under unsupported UNSUPPORTED until 7b
secret_tunnels/tunnel_hatch tunnel.under unsupported UNSUPPORTED until 7b
ship_town/ship_deck zone.standard fits
ship_town/ship_hull form.ship_hull unsupported UNSUPPORTED until unscheduled
ship_town/ship_masts form.mast unsupported UNSUPPORTED until unscheduled
sky_monastery/cloister zone.standard fits
sky_monastery/long_stair connector.stair unsupported UNSUPPORTED until 7a
sky_monastery/sky_island form.floating_island unsupported UNSUPPORTED until N-P0-1
sorting_warehouse/trading_post zone.standard fits
spiral_town/hill_town zone.standard fits
spiral_town/spiral_road connector.street refused UNREACHABLE
spiral_town/hill_relief form.relief blocked DEPENDENCY
spiral_town/spiral_shape rule.shape unsupported UNSUPPORTED until RC
survival_village/village zone.standard fits
swamp_stilts/hollow zone.standard fits
swamp_stilts/rope_bridges connector.rope_bridge refused NO_GAP
terraced_hill/town zone.standard fits
terraced_hill/switchback_street connector.street fits
terraced_hill/terraces form.terrace refused OVERLAP
trade_hub/market_town zone.standard fits
treetop_village/canopy zone.standard fits
treetop_village/bridge_cabin_1 connector.rope_bridge refused NO_GAP
treetop_village/bridge_cabin_2 connector.rope_bridge refused NO_GAP
treetop_village/bridge_cabin_3 connector.rope_bridge refused NO_GAP
treetop_village/bridge_cabin_4 connector.rope_bridge refused NO_GAP
treetop_village/bridge_tavern connector.rope_bridge refused NO_GAP
treetop_village/bridge_tower connector.rope_bridge refused NO_GAP
treetop_village/bridge_barn connector.rope_bridge refused NO_GAP
treetop_village/bridge_cottage connector.rope_bridge refused NO_GAP
treetop_village/bridge_shop connector.rope_bridge refused NO_GAP
treetop_village/storehouse_lift connector.lift unsupported UNSUPPORTED until 7a
twin_villages/villages zone.standard fits
twin_villages/village_road connector.road fits
two_districts/town zone.standard fits
two_districts/craftsmen_district program.districts unsupported UNSUPPORTED
underwater_domes/colony zone.standard refused NO_FEATURE
underwater_domes/glass_tunnels connector.tunnel blocked DEPENDENCY
underwater_domes/sea_floor form.seabed_site unsupported UNSUPPORTED until later
upside_down/village zone.standard fits
upside_down/main_street connector.street fits
upside_down/chain_bridges connector.rope_bridge refused NO_GAP
upside_down/winch_lift connector.lift unsupported UNSUPPORTED until 7a
upside_down/hang_from_ceiling rule.suspended unsupported UNSUPPORTED until 7b
walled_town/town zone.standard fits
walled_town/town_wall connector.wall adjusted
war_camp/camp zone.standard fits
war_camp/camp_palisade connector.wall fits
war_camp/camp_relief form.relief fits
winter_festival/town zone.standard fits
