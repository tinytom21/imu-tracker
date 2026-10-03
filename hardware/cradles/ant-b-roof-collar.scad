// ============================================
// Antenna cradle B: roof collar for the Tallysman TW7972 (69 mm dia, 22 mm high)
// A tube that slides over the whole antenna and stands on the roof on three feet. It is
// centred by the antenna's side but its height comes from the roof surface, not the
// radome, so it does not depend on the radome shape. A slot clears the cable.
// The phone seat is centred on the antenna axis, as in cradle A.
// ============================================
include <common.scad>

ant_d = 69;        // [mm]
ant_h = 22;        // [mm]
skin = 2.5;        // [mm]
fit = 0.3;         // [mm] radial clearance (Bambu X2D, PLA): ~0.3 mm centring slop
gap_top = 3;       // [mm] clearance above the radome
foot_h = 2;        // [mm] three feet on the roof (a curved roof still gives 3 contacts)
slot_w = 14;       // [mm] cable slot width (SMA cable exits the antenna side)
slot_h = 12;       // [mm]

tube_h = ant_h + gap_top;

module collar() {
    difference() {
        union() {
            cylinder(d = ant_d + 2 * (fit + skin), h = tube_h + skin);
            for (a = [90, 210, 330]) rotate(a) translate([ant_d / 2 + fit + skin / 2, 0, -foot_h]) cylinder(d = 8, h = foot_h + eps);
        }
        translate([0, 0, -eps]) cylinder(d = ant_d + 2 * fit, h = tube_h + eps);
        // cable slot, facing -X (rotate the collar to suit the cable)
        translate([-(ant_d / 2 + skin + fit + 1), -slot_w / 2, -eps]) cube([skin + 2, slot_w, slot_h]);
    }
}

// roof at z = -foot_h
collar();
c = seat_phone_centre();
translate([-c.x, -c.y, tube_h + skin]) phone_seat("ANT");

%cylinder(d = ant_d, h = ant_h);
if (show_phone) %translate([-c.x, -c.y, tube_h + skin]) phone_ghost();
