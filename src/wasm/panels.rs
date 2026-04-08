//! Predefined clinical gene panels.

#[derive(Debug, Clone, serde::Serialize)]
pub struct GenePanel {
    pub name: String,
    pub genes: Vec<String>,
}

pub fn predefined_panels() -> Vec<GenePanel> {
    vec![
        GenePanel {
            name: "Familial Hypercholesterolemia".into(),
            genes: vec!["LDLR", "APOB", "PCSK9", "LDLRAP1"].iter().map(|s| s.to_string()).collect(),
        },
        GenePanel {
            name: "Hereditary Breast/Ovarian Cancer".into(),
            genes: vec!["BRCA1", "BRCA2", "PALB2", "TP53", "PTEN", "ATM", "CHEK2", "RAD51C", "RAD51D", "BARD1"].iter().map(|s| s.to_string()).collect(),
        },
        GenePanel {
            name: "Cardiomyopathy".into(),
            genes: vec!["MYH7", "MYBPC3", "TNNT2", "TNNI3", "LMNA", "SCN5A", "TTN", "DSP", "FLNC", "RBM20"].iter().map(|s| s.to_string()).collect(),
        },
        GenePanel {
            name: "Epilepsy".into(),
            genes: vec!["SCN1A", "SCN2A", "KCNQ2", "CDKL5", "STXBP1", "SCN8A", "PCDH19", "SLC2A1", "KCNA2"].iter().map(|s| s.to_string()).collect(),
        },
        GenePanel {
            name: "Lynch Syndrome".into(),
            genes: vec!["MLH1", "MSH2", "MSH6", "PMS2", "EPCAM"].iter().map(|s| s.to_string()).collect(),
        },
        GenePanel {
            name: "Connective Tissue Disorders".into(),
            genes: vec!["FBN1", "COL3A1", "COL5A1", "COL5A2", "TGFBR1", "TGFBR2", "SMAD3"].iter().map(|s| s.to_string()).collect(),
        },
        GenePanel {
            name: "RASopathies".into(),
            genes: vec!["PTPN11", "SOS1", "RAF1", "KRAS", "BRAF", "MAP2K1", "MAP2K2", "HRAS", "SHOC2", "CBL"].iter().map(|s| s.to_string()).collect(),
        },
        GenePanel {
            name: "Pharmacogenomics Core".into(),
            genes: vec!["CYP2D6", "CYP2C19", "CYP2C9", "CYP3A5", "DPYD", "TPMT", "NUDT15", "VKORC1", "SLCO1B1", "UGT1A1"].iter().map(|s| s.to_string()).collect(),
        },
    ]
}
