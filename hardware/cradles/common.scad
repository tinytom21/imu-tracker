// ============================================
// Offset cradles: shared phone seat
// A 3-2-1 kinematic seat: 3 domed pads carry the phone, 2 bumps on the long datum wall
// and 1 bump on the short datum wall locate it. The seat slopes slightly down towards the
// datum corner so gravity pushes the phone home. Every cradle places this seat.
// Seat origin = datum corner of the phone (x along the phone's long edge, y along its short edge).
// ============================================

// --- Phone (Samsung Galaxy S23 bare; add a case with case_allow) ---
phone_l = 146.3;     // [mm]
phone_w = 70.9;      // [mm]
phone_t = 7.6;       // [mm]
case_allow = 0;      // [mm] added to each dimension for a case
clear = 0.5;         // [mm] gap on the open (non-datum) sides (Bambu X2D, PLA)

// --- Seat ---
plate_t = 3;         // [mm] seat plate thickness
margin = 4;          // [mm] plate beyond the phone on the open sides
wall_t = 3;          // [mm] datum wall thickness
wall_h = 6;          // [mm] datum wall height above the pads
pad_d = 6;           // [mm] support pad diameter
pad_h = 1.2;         // [mm] support pad height
bump_r = 1.5;        // [mm] locating bump radius
tilt = 2;            // [deg] slope towards the datum corner, in x and in y

show_phone = true;   // preview only: ghost of the phone in the seat
$fn = 48;
eps = 0.01;

PL = phone_l + case_allow;
PW = phone_w + case_allow;
PT = phone_t + case_allow;

// Seat footprint in seat coordinates: datum walls sit at x<0 and y<0.
seat_x0 = -wall_t - bump_r;
seat_y0 = -wall_t - bump_r;
seat_len = PL + clear + margin - seat_x0;
seat_wid = PW + clear + margin - seat_y0;

// Phone-centre in seat coordinates (handy for centring a seat over a point).
function seat_phone_centre() = [PL / 2, PW / 2];

// The tilt: rotate about the datum corner so the far corner is highest and the phone
// slides towards the datum walls (x-rotation lifts +y, negative y-rotation lifts +x).
module tilted() {
    rotate([tilt, -tilt, 0]) children();
}

module seat_plate_2d() {
    difference() {
        translate([seat_x0, seat_y0]) offset(r = 3) offset(delta = -3) square([seat_len, seat_wid]);
        // finger notch on the open long side, and one on the open short end
        translate([PL / 2, PW + clear + margin + 6]) circle(d = 34);
        translate([PL + clear + margin + 6, PW / 2]) circle(d = 30);
    }
}

module seat_features() {
    // three support pads (kinematic: exactly three points of contact)
    for (p = [[18, 14], [18, PW - 14], [PL - 18, PW / 2]])
        translate([p.x, p.y, plate_t]) scale([1, 1, pad_h / (pad_d / 2)]) sphere(d = pad_d);
    // long datum wall (y < 0) with two locating bumps
    translate([seat_x0, -wall_t - bump_r, 0]) cube([PL * 0.9 - seat_x0, wall_t, plate_t + pad_h + wall_h]);
    // dome bumps protruding from the wall face to the phone edge at y = 0
    for (x = [PL * 0.2, PL * 0.75])
        translate([x, -bump_r, plate_t + pad_h + PT * 0.4]) sphere(r = bump_r);
    // short datum wall (x < 0) with one locating bump
    translate([-wall_t - bump_r, seat_y0, 0]) cube([wall_t, PW * 0.85 - seat_y0, plate_t + pad_h + wall_h]);
    translate([-bump_r, PW / 2, plate_t + pad_h + PT * 0.4]) sphere(r = bump_r);
}

// Seat on top of a flat surface at z = 0, with the wedge underneath filled in.
module phone_seat(label = "") {
    tilted() {
        linear_extrude(plate_t) seat_plate_2d();
        seat_features();
        // label engraved... as a raised mark so it prints without bridging
        if (label != "")
            translate([PL * 0.5, PW * 0.5, plate_t - eps])
                linear_extrude(0.6) text(label, size = 9, halign = "center", valign = "center");
        // forward arrow along +x (phone long axis = the cradle's X)
        translate([PL * 0.5, PW * 0.2, plate_t - eps]) linear_extrude(0.6) arrow_2d(30);
    }
    // wedge fill between z = 0 and the tilted plate
    hull() {
        linear_extrude(eps) seat_plate_2d();
        tilted() linear_extrude(eps) seat_plate_2d();
    }
}

module arrow_2d(len) {
    translate([-len / 2, 0]) union() {
        translate([0, -1.5]) square([len - 8, 3]);
        translate([len - 8, 0]) polygon([[0, -5], [8, 0], [0, 5]]);
    }
}

// A ghost of the phone sitting in the seat, for previews only (use with %).
module phone_ghost() {
    tilted() translate([0, 0, plate_t + pad_h]) cube([PL, PW, PT]);
}
