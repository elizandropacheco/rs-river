// Metadados fixos das estações monitoradas na Bacia do Guaíba.
// slug = caminho usado em https://nivelguaiba.com.br/<slug>
// ibge = código IBGE do município (usado nas consultas ao CEMADEN)
// cotas (opcional) = cotas OFICIAIS de atenção/alerta da régua, em metros
//   (ex.: cotas: { atencao: 2.5, alerta: 3.2 }). Quando definidas, o status
//   usa esses valores absolutos em vez da heurística 75%/90% da cota de
//   inundação. Preencha conforme o SACE/Defesa Civil publicar por estação.
export const STATIONS = [
  // wind: estação sujeita ao represamento por vento sul (sistema Guaíba /
  // Lagoa dos Patos). Só faz sentido no Guaíba — rios de encosta não sofrem isso.
  { slug: "portoalegre",       city: "Porto Alegre",         river: "Rio Guaíba",   flood: 3.00,  lat: -30.0346, lng: -51.2177, wind: true, ibge: 4314902 },
  { slug: "saoleopoldo",       city: "São Leopoldo",         river: "Rio dos Sinos", flood: 4.50,  lat: -29.7603, lng: -51.1472, ibge: 4318705 },
  { slug: "taquara",           city: "Taquara",              river: "Rio dos Sinos", flood: 6.00,  lat: -29.6506, lng: -50.7803, ibge: 4321204 },
  { slug: "lajeado",           city: "Lajeado",              river: "Rio Taquari",  flood: 19.00, lat: -29.4669, lng: -51.9611, ibge: 4311403 },
  { slug: "bomretirodosul",    city: "Bom Retiro do Sul",    river: "Rio Taquari",  flood: 19.00, lat: -29.6039, lng: -51.9469, ibge: 4302402 },
  { slug: "encantado",         city: "Encantado",            river: "Rio Taquari",  flood: 12.00, lat: -29.2361, lng: -51.8697, ibge: 4306809 },
  { slug: "mucum",             city: "Muçum",                river: "Rio Taquari",  flood: 18.00, lat: -29.1667, lng: -51.8706, ibge: 4312609 },
  { slug: "rocasales",         city: "Roca Sales",           river: "Rio Taquari",  flood: 18.00, lat: -29.2587, lng: -51.8277, ibge: 4315800 },
  { slug: "feliz",             city: "Feliz",                river: "Rio Caí",      flood: 9.00,  lat: -29.4517, lng: -51.3050, ibge: 4308102 },
  { slug: "saosebastiaodocai", city: "São Sebastião do Caí", river: "Rio Caí",      flood: 10.00, lat: -29.5872, lng: -51.3767, ibge: 4319505 },
  { slug: "gravatai",          city: "Gravataí",             river: "Rio Gravataí", flood: 4.75,  lat: -29.9444, lng: -50.9919, ibge: 4309209 },
  { slug: "cachoeiradosul",    city: "Cachoeira do Sul",     river: "Rio Jacuí",    flood: 18.00, lat: -30.0392, lng: -52.8933, ibge: 4303004 },
  { slug: "donafrancisca",     city: "Dona Francisca",       river: "Rio Jacuí",    flood: 7.50,  lat: -29.6169, lng: -53.3628, ibge: 4306700 },
  { slug: "riopardo",          city: "Rio Pardo",            river: "Rio Jacuí",    flood: 12.50, lat: -29.9897, lng: -52.3697, ibge: 4315701 },
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
