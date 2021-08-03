process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://9ec6ca2731574cb481734eeac8266b6c@sentry.cozycloud.cc/152'

const {
  BaseKonnector,
  requestFactory,
  scrape,
  saveBills,
  saveFiles,
  log,
  utils
} = require('cozy-konnector-libs')

// Librairies diverses
const PassThrough = require('stream').PassThrough

// Initialisation d'une variable pour le partage des cookies entre instances
const request = requestFactory()
const j = request.jar()

// Instance pour la récupération de réponse HTML
const requestHtml = requestFactory({
  debug: false,
  cheerio: true,
  json: false,
  jar: j,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36'
  }
})

// Instance pour la récupération de réponse JSON
const requestJson = requestFactory({
  debug: false,
  cheerio: false,
  json: true,
  jar: j
})

// Instance pour la récupération des fichiers pdf
const requestPdf = requestFactory({
  debug: false,
  cheerio: false,
  json: false,
  jar: j,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:62.0) Gecko/20100101 Firefox/62.0',
    Accept: 'application/pdf'
  }
})

// Instance pour la récupération des Stream
const requestStream = requestFactory({
  debug: false,
  cheerio: false,
  json: false,
  jar: j,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:62.0) Gecko/20100101 Firefox/62.0',
    Accept: 'application/octet-stream'
  }
})

// Variables pour l'initialisation d'utilitaires
const replace = String.prototype.replace
const qs = require('querystring')

// Variables liees au site
const VENDOR = 'PRIXTEL'
const baseUrl = 'https://www.prixtel.com'
const baseApiUrl = 'https://www.prixtel.com'

const loginUrl = baseUrl + '/pws/SSO/authentication' // Pour login
const creationfactureUrl = baseUrl + '/ws/EC_get_proc_modal' // Pour la création des factures détaillées
const listedocumentUrl = baseUrl + '/pws/ec/get-customer-documents' // Pour récupérer la liste des documents contractuels
const filedlUrl = baseUrl + '/ws/file' // Pour le téléchargement des factures détaillées + mandat
const infoclientUrl = baseUrl + '/pws/ec/get-qualif-infos' // Pour récupérer les informations sur le client

// Récupération liste facture
const listefactureUrl = 'https://prixtel-v2.prixtel.com/api/bills' // Pour la liste des factures
const facturedlUrl =
  'https://external-pxl-aws-s3.prixtel.com/api/file/download/billingId/' // Pour la récupération des factures simples
const facturedlDir = '/home/_services_/pxl_files/billing/' // Répertoire en paramètre des request
const contratUrl =
  'https://external-pxl-aws-s3.prixtel.com/api/file/download/file-type/customers_contract/extra/' // Pour le téléchargement des contrats

// Jeton pour l'authentification du site 
let xToken = null

// Initialisation du connecteur
module.exports = new BaseKonnector(start)

// Récupération du jeton d'authentification
async function extractToken() {
  log('info', 'Récupération du Token dans les cookies')
  let cookie = j.getCookies(baseUrl).find(cookie => cookie.key === 'prixtel_ec')

  // On verifie que le cookie existe
  if (!cookie) {
    log('error', 'Erreur dans la récupération du jeton')
    throw new Error(errors.VENDOR_DOWN)
  }

  // Decodage URI du cookie et remplacement des /
  cookie = decodeURIComponent(cookie.value)
  cookie = cookie
    .replace(/\\/gi, '')
    .replace(/"{/gi, '{')
    .replace(/}"/gi, '}')

  // On converti le cookie en JSON
  cookie = JSON.parse(cookie)

  xToken = cookie.session
}

// Fonction principal du connecteur
async function start(fields, cozyParameters) {
  // Authentification
  log('info', 'Authentification ...')
  await authenticate.bind(this)(fields.login, fields.password)
  log('info', 'Correctement authentifié')

  // Extraction du jeton d'authentification
  await extractToken()

  // Récupération des informations sur le client
  let infos_client = await requestJson({
    uri:
      `${infoclientUrl}/?` +
      qs.encode({
        token: xToken,
        data: '{"path":"ligne-mobile"}'
      })
  })

  // Suppression de l'arborescence du JSON
  infos_client = infos_client.model

  // Récupération des factures simples et détaillées
  await getFactures(fields, infos_client.cid)

  // Récupération des documents contractuels
  await getDocuments(fields, infos_client.cid)
}

// Fonction d'authentification au site
function authenticate(username, password) {
  return this.signin({
    requestInstance: requestHtml,
    url: `${loginUrl}`,
    formSelector: '#wpx_loginForm',
    formData: { email: username, pwd: password },

    validate: (statusCode, $, fullResponse) => {
      if ($('.connected_user_name').length === 1) {
        return true
      } else {
        log('error', $('div .wpx_errors li').text())
        return false
      }
    }
  })
}

// Import des Factures
async function getFactures(fields, id_client) {
  // Récupération de la liste des factures
  const liste_factures = await requestJson({
    uri: `${listefactureUrl}`,
    headers: {
      'X-Auth': xToken
    }
  })

  // Conversion du JSON pour les factures simples
  log('info', 'Mise en forme des factures')
  let factures = liste_factures.map(facture => ({
    vendor: VENDOR,
    date: parseDate(facture.date),
    amount: new Number(facture.totalTtc),
    currency: 'EUR',
    vendorRef: facture.id,
    filename: formaliseNomfacture(
      facture.date,
      facture.totalTtc,
      facture.period,
      facture.id,
      false
    ),
    fileurl:
      `${facturedlUrl}` +
      facture.id +
      '?' +
      qs.encode({
        token: xToken
      }),
    metadata: {
      importDate: new Date(),
      version: 1
    }
  }))

  // Import des factures dans COZY
  log('info', 'Sauvegarde des factures dans Cozy')
  await saveBills(factures, fields, {
    subPath: '',
    identifiers: ['prixtel'],
    requestInstance: requestPdf,
    contentType: 'application/pdf',
    sourceAccount: fields.login,
    sourceAccountIdentifier: fields.login,
    fileIdAttributes: ['filename']
  })

  // Conversion du JSON pour les factures détaillées
  log('info', 'Mise en forme des factures détaillées')
  let factures_detaillees = liste_factures.map(facture => ({
    vendor: VENDOR,
    date: parseDate(facture.date),
    amount: new Number(facture.totalTtc),
    currency: 'EUR',
    vendorRef: facture.id,
    filename: formaliseNomfacture(
      facture.date,
      facture.totalTtc,
      facture.period,
      facture.id,
      true
    ),
    fileurl:
      `${filedlUrl}/?` +
      qs.encode({
        token: xToken,
        file:
          facturedlDir +
          facture.month +
          '/' +
          facture.id +
          '-' +
          facture.customer.id +
          '-detail.pdf',
        display: facture.id + '-' + facture.customer.id + '-detail.pdf',
        csv: 'n'
      }),

    creationurl:
      `${creationfactureUrl}?` +
      qs.encode({
        token: xToken,
        procId: '218',
        missionId: '',
        oid: 'fact__' + facture.id,
        month: facture.month,
        user_ext: '',
        home: '06E'
      }),

    fetchFile: async function(d) {
      log('info', 'Récupération facture détaillée : ' + d.vendorRef)

      await requestJson({
        uri: d.creationurl
      })

      return requestPdf({
        uri: d.fileurl
      }).pipe(new PassThrough())
    }
  }))

  // Import des factures dans COZY
  log('info', 'Sauvegarde des factures détaillées dans Cozy')
  await saveFiles(factures_detaillees, fields, {
    identifiers: ['prixtel'],
    contentType: 'application/pdf',
    sourceAccount: fields.login,
    sourceAccountIdentifier: fields.login,
    fileIdAttributes: ['filename']
  })
}

// Import des documents
async function getDocuments(fields, id_client) {
  // Récupération de la liste des documents
  log('info', 'Récupération de liste des documents')
  let liste_documents = await requestJson({
    uri:
      `${listedocumentUrl}?` +
      qs.encode({
        token: xToken,
        data: '{}'
      })
  })

  // On récupère que les données utiles
  liste_documents = liste_documents.model

  // Tableau contenant la liste des documents à sauvegarder dans COZY
  log('info', 'Mise en forme des documents contractuels')
  const documents = []

  // Ajout du mandat
  if (liste_documents.mandat_file) {
    documents.push({
      fileurl:
        `${filedlUrl}/?` +
        qs.encode({
          token: xToken,
          file: liste_documents.mandat_path + liste_documents.mandat_file,
          display: liste_documents.mandat_file,
          csv: 'n'
        }),
      filename: formaliseNomDocument('MANDAT', '')
    })
  }

  // Préparation des documents contractuels
  for (const doc of liste_documents.gsms) {
    if (doc.line_id) {
      // Conditions générales de vente
      if (doc.cgv) {
        documents.push({
          fileurl: doc.cgv,
          filename: formaliseNomDocument('CGV', doc.line_id)
        })
      }

      // Guide tarifaire
      if (doc.offer_gt) {
        documents.push({
          fileurl: doc.offer_gt,
          filename: formaliseNomDocument('OFFER_GT', doc.line_id)
        })
      }

      // Guide tarifaire internationnal
      if (doc.offer_gt_intl) {
        documents.push({
          fileurl: doc.offer_gt_intl,
          filename: formaliseNomDocument('OFFER_GT_INTL', doc.line_id)
        })
      }

      // Fiche standardisee
      if (doc.offer_link) {
        documents.push({
          fileurl: doc.offer_link,
          filename: formaliseNomDocument('OFFER_LINK', doc.line_id)
        })
      }
    }
  }

  // Téléchargement des fichiers
  log('info', 'Sauvegarde des documents contractuels dans Cozy')
  await saveFiles(documents, fields, {
    requestInstance: requestPdf,
    fileIdAttributes: ['filename'],
    sourceAccount: fields.login,
    sourceAccountIdentifier: fields.login
  })

  // Préparation de la téléchargement des contrats
  log('info', 'Mise en forme des contrats')
  const contrats = []

  // Ajout des documents pour toutes les lignes
  for (const doc of liste_documents.gsms) {
    if (doc.line_id) {
      // Contrat lie a la ligne
      contrats.push({
        filestream: await requestStream(
          `${contratUrl}` +
            doc.line_id +
            `?` +
            qs.encode({
              token: xToken
            })
        ).pipe(new PassThrough()),
        filename: formaliseNomDocument('CONTRAT', doc.line_id)
      })
    }
  }

  // Sauvegarde des contrats dans COZY
  log('info', 'Sauvegarde des contrats dans Cozy')
  await saveFiles(contrats, fields, {
    fileIdAttributes: ['filename'],
    sourceAccount: fields.login,
    sourceAccountIdentifier: fields.login,
    identifiers: ['prixtel'],
    contentType: 'application/pdf'
  })
}

// Convertit une date au format chaîne en objet Date JS
function parseDate(sDate) {
  let tabChiffres = sDate.split('/')
  return new Date(tabChiffres[2] + '-' + tabChiffres[1] + '-' + tabChiffres[0])
}

// Convert a Date object to a ISO date string
function formatDate(date) {
  let year = date.getFullYear()
  let month = date.getMonth() + 1
  let day = date.getDate()
  if (month < 10) {
    month = '0' + month
  }

  if (day < 10) {
    day = '0' + day
  }

  return `${year}-${month}-${day}`
}

// Formalise le nom des factures
function formaliseNomfacture(dDate, mMontant, sPeriode, sReference, bDetail) {
  let periode = sPeriode.replace('é', 'e').replace(' ', '_')
  let detail = bDetail == true ? '_detail' : ''
  let date = parseDate(dDate)
  let montant = new Number(mMontant)

  return (
    formatDate(date) +
    '_' +
    VENDOR +
    '_' +
    montant.toFixed(2) +
    'EUR' +
    '_' +
    periode +
    '_' +
    sReference +
    detail +
    '.pdf'
  )
}

// Formalise le nom des documents
function formaliseNomDocument(type, num_ligne) {
  if (type == 'CGV') nom = 'CGV'
  else if (type == 'OFFER_GT') nom = 'Guide_Tarifaire'
  else if (type == 'OFFER_GT_INTL') nom = 'Guide_Tarifaire_International'
  else if (type == 'OFFER_LINK') nom = 'Fiche_Standardisee'
  else if (type == 'CONTRAT') nom = 'Contrat'
  else if (type == 'MANDAT') nom = 'Mandat_Sepa'

  if (num_ligne == '') return VENDOR + '_' + nom + '.pdf'
  else return VENDOR + '_' + nom + '_' + num_ligne + '.pdf'
}
