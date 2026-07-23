// Metadados fixos das estações monitoradas na Bacia do Guaíba.
// slug = caminho usado em https://nivelguaiba.com.br/<slug>
export const STATIONS = [
  { slug: "portoalegre",       city: "Porto Alegre",         river: "Rio Guaíba",   flood: 3.00,  lat: -30.0346, lng: -51.2177 },
  { slug: "saoleopoldo",       city: "São Leopoldo",         river: "Rio dos Sinos", flood: 4.50,  lat: -29.7603, lng: -51.1472 },
  { slug: "taquara",           city: "Taquara",              river: "Rio dos Sinos", flood: 6.00,  lat: -29.6506, lng: -50.7803 },
  { slug: "lajeado",           city: "Lajeado",              river: "Rio Taquari",  flood: 19.00, lat: -29.4669, lng: -51.9611 },
  { slug: "bomretirodosul",    city: "Bom Retiro do Sul",    river: "Rio Taquari",  flood: 19.00, lat: -29.6039, lng: -51.9469 },
  { slug: "encantado",         city: "Encantado",            river: "Rio Taquari",  flood: 12.00, lat: -29.2361, lng: -51.8697 },
  { slug: "mucum",             city: "Muçum",                river: "Rio Taquari",  flood: 18.00, lat: -29.1667, lng: -51.8706 },
  { slug: "rocasales",         city: "Roca Sales",           river: "Rio Taquari",  flood: 18.00, lat: -29.2587, lng: -51.8277 },
  { slug: "feliz",             city: "Feliz",                river: "Rio Caí",      flood: 9.00,  lat: -29.4517, lng: -51.3050 },
  { slug: "saosebastiaodocai", city: "São Sebastião do Caí", river: "Rio Caí",      flood: 10.00, lat: -29.5872, lng: -51.3767 },
  { slug: "gravatai",          city: "Gravataí",             river: "Rio Gravataí", flood: 4.75,  lat: -29.9444, lng: -50.9919 },
  { slug: "cachoeiradosul",    city: "Cachoeira do Sul",     river: "Rio Jacuí",    flood: 18.00, lat: -30.0392, lng: -52.8933 },
  { slug: "donafrancisca",     city: "Dona Francisca",       river: "Rio Jacuí",    flood: 7.50,  lat: -29.6169, lng: -53.3628 },
  { slug: "riopardo",          city: "Rio Pardo",            river: "Rio Jacuí",    flood: 12.50, lat: -29.9897, lng: -52.3697 },
];

export const BASE_URL = "https://nivelguaiba.com.br";

// Cor por bacia/rio – usada no front para agrupar visualmente.
export const RIVER_COLORS = {
  "Rio Guaíba":   "#38bdf8",
  "Rio dos Sinos":"#a78bfa",
  "Rio Taquari":  "#f472b6",
  "Rio Caí":      "#34d399",
  "Rio Gravataí": "#fbbf24",
  "Rio Jacuí":    "#60a5fa",
};

export function stationBySlug(slug) {
  return STATIONS.find((s) => s.slug === slug);
}
