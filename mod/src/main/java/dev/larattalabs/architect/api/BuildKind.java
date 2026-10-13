package dev.larattalabs.architect.api;

/**
 * A build's kind guess (§4): HOUSE (an entrance and an enclosure, or a bed), BARN (an enclosure over 200 floor cells), FARM
 * (farmland and crops are the majority of the footprint), WALL (at most 2 thick, at least 8 long, no roof), TOWER (height at least
 * twice the footprint's longer side), PATH (path blocks are the majority), OTHER. New values are only ever appended. Since PT.
 */
public enum BuildKind {
	HOUSE, BARN, FARM, WALL, TOWER, PATH, OTHER
}
