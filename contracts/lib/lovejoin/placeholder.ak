// M0 placeholder. Real modules land in M1 (crypto) and M2 (validators).
// Keeps `aiken check` happy on a clean checkout — see docs/spec/12-build-guide.md.

pub const protocol_version: Int = 1

test protocol_version_is_one() {
  protocol_version == 1
}
