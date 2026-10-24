// Former databaserader til det appen får se. Her bestemmes hva som er offentlig.
const { fuzzLocation } = require("./geo");

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "Nabo";
}

function images(raw) {
  return (raw || []).map((img) => ({ id: img.id, kind: img.kind, url: `/images/${img.id}` }));
}

// SELECT-del som alle offentlige annonsespørringer deler (krever alias l for listings, u for selger).
const PUBLIC_LISTING_COLUMNS = `
  l.id, l.seller_id, l.title, l.brand, l.category, l.deal_price, l.original_price,
  l.expiry_date, l.pickup_deadline, l.storage, l.status, l.area, l.lat, l.lng,
  l.weight_g, l.product_image_url, l.created_at,
  u.display_name AS seller_name, u.seller_rating, u.seller_rating_count, u.created_at AS seller_since,
  (SELECT COUNT(*)::int FROM deals d WHERE d.seller_id = l.seller_id AND d.status = 'completed') AS seller_rescued,
  COALESCE((SELECT json_agg(json_build_object('id', i.id, 'kind', i.kind) ORDER BY i.sort)
            FROM listing_images i WHERE i.listing_id = l.id), '[]'::json) AS images`;

// Offentlig annonse: ingen adresse, og posisjonen er forskjøvet.
function publicListing(row) {
  const approx = fuzzLocation(row.lat, row.lng, row.id);
  return {
    id: row.id,
    seller_id: row.seller_id,
    title: row.title,
    brand: row.brand,
    category: row.category,
    deal_price: row.deal_price != null ? Number(row.deal_price) : 0,
    original_price: row.original_price != null ? Number(row.original_price) : null,
    expiry_date: row.expiry_date,
    pickup_deadline: row.pickup_deadline,
    storage: row.storage,
    status: row.status,
    area: row.area,
    approx_lat: approx.lat,
    approx_lng: approx.lng,
    weight_g: row.weight_g,
    product_image_url: row.product_image_url,
    created_at: row.created_at,
    images: images(row.images),
    seller: {
      id: row.seller_id,
      first_name: firstName(row.seller_name),
      rating: row.seller_rating != null ? Number(row.seller_rating) : null,
      rating_count: row.seller_rating_count || 0,
      rescued: row.seller_rescued || 0,
      member_since: row.seller_since,
      verified: true,
    },
  };
}

// Selgerens egen annonse: inkluderer full adresse.
function ownListing(row) {
  return {
    ...publicListing(row),
    address: row.address,
    lat: row.lat != null ? Number(row.lat) : null,
    lng: row.lng != null ? Number(row.lng) : null,
    active_deal_id: row.active_deal_id || null,
  };
}

const REVEALED_STATUSES = ["confirmed", "completed"];

// Avtale sett fra én av partene. Eksakt adresse vises kjøperen først når tid er avtalt.
function dealFor(row, userId) {
  const role = row.buyer_id === userId ? "buyer" : "seller";
  const revealed = role === "seller" || REVEALED_STATUSES.includes(row.status);
  const counterpartName = role === "buyer" ? row.seller_name : row.buyer_name;
  const myConfirm = role === "buyer" ? row.completion_confirmed_by_buyer : row.completion_confirmed_by_seller;
  const theirConfirm = role === "buyer" ? row.completion_confirmed_by_seller : row.completion_confirmed_by_buyer;
  return {
    id: row.id,
    listing_id: row.listing_id,
    role,
    status: row.status,
    title: row.title,
    brand: row.brand,
    category: row.category,
    deal_price: row.deal_price != null ? Number(row.deal_price) : 0,
    original_price: row.original_price != null ? Number(row.original_price) : null,
    weight_g: row.weight_g,
    expiry_date: row.expiry_date,
    storage: row.storage,
    pickup_deadline: row.pickup_deadline,
    reserved_at: row.reserved_at,
    proposed_at: row.proposed_at,
    proposed_by: row.proposed_by,
    awaiting_my_answer: row.status === "reserved" && row.proposed_at != null && row.proposed_by !== role,
    meetup_at: row.meetup_at,
    confirmed_at: row.confirmed_at,
    completed_at: row.completed_at,
    cancel_reason: row.cancel_reason,
    cancelled_by: row.cancelled_by,
    no_show_party: row.no_show_party,
    i_confirmed_pickup: Boolean(myConfirm),
    they_confirmed_pickup: Boolean(theirConfirm),
    i_rated: Boolean(row.i_rated),
    area: row.area,
    address: revealed ? row.address : null,
    lat: revealed && row.lat != null ? Number(row.lat) : null,
    lng: revealed && row.lng != null ? Number(row.lng) : null,
    location_revealed: revealed,
    product_image_url: row.product_image_url,
    images: images(row.images),
    counterpart: {
      id: role === "buyer" ? row.seller_id : row.buyer_id,
      name: revealed ? counterpartName || "Nabo" : firstName(counterpartName),
      rating: role === "buyer"
        ? (row.seller_rating != null ? Number(row.seller_rating) : null)
        : (row.buyer_rating != null ? Number(row.buyer_rating) : null),
      rating_count: (role === "buyer" ? row.seller_rating_count : row.buyer_rating_count) || 0,
    },
    created_at: row.created_at,
  };
}

// SELECT for avtaler. $1 må være innlogget bruker-ID.
const DEAL_SELECT = `
  SELECT d.*, l.brand, l.storage, l.expiry_date, l.area, l.lat, l.lng, l.weight_g, l.product_image_url,
         bu.display_name AS buyer_name, su.display_name AS seller_name,
         bu.buyer_rating, bu.buyer_rating_count, su.seller_rating, su.seller_rating_count,
         EXISTS (SELECT 1 FROM ratings r WHERE r.deal_id = d.id AND r.from_user_id = $1) AS i_rated,
         COALESCE((SELECT json_agg(json_build_object('id', i.id, 'kind', i.kind) ORDER BY i.sort)
                   FROM listing_images i WHERE i.listing_id = d.listing_id), '[]'::json) AS images
    FROM deals d
    JOIN listings l ON l.id = d.listing_id
    JOIN users bu ON bu.id = d.buyer_id
    JOIN users su ON su.id = d.seller_id`;

module.exports = { PUBLIC_LISTING_COLUMNS, publicListing, ownListing, dealFor, DEAL_SELECT, firstName };
