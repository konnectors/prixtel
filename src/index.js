process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://9ec6ca2731574cb481734eeac8266b6c@sentry.cozycloud.cc/152'

const {
  BaseKonnector,
  requestFactory,
  saveBills,
  saveFiles,
  log,
  errors,
  cozyClient
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

// Importing models to get qualification by label
const models = cozyClient.new.models
const { Qualification } = models.document

// Instance pour la récupération de réponse JSON et fichier PDF
let requestJson

// Variables liees au site
const VENDOR = 'PRIXTEL'
const baseUrl = 'https://espaceclient.prixtel.com'
const loginUrl = baseUrl + '/api/login' // Pour login
// const infoclientUrl = baseUrl + '/api/customer' // Pour récupérer les informations sur le client
const listefacturesUrl = baseUrl + '/api/bills' // Pour la liste des factures
const fichierdlUrl = 'https://external-pxl-aws-s3.prixtel.com/api/file/download' // Pour le téléchargement de fichier
const listelignesUrl = baseUrl + '/api/gsm/customer/msisdn/list' // Pour r{écupérer des lignes sur le compte
const listedocumentsUrl = baseUrl + '/api/gsm/line' // Pour récupérer la liste des documents contractuels

// Initialisation du connecteur
module.exports = new BaseKonnector(start)

// Fonction principal du connecteur
async function start(fields) {
  // Initialisation des requests avec le token authorisation en paramètre
  init_request('')

  // Authentification
  log('info', 'Authentification ...')
  await this.deactivateAutoSuccessfulLogin()
  await authenticate.bind(this)(fields.login, fields.password)
  await this.notifySuccessfulLogin()
  log('info', 'Correctement authentifié')

  // Récupération des informations sur le client
  // let infos_client = await requestJson(`${infoclientUrl}`)

  // Récupération des factures simples et détaillées
  await getFactures(fields)

  // Récupération des documents contractuels
  await getDocuments(fields)
}

// Fonction permettant d'initialiser les requests avec le token Authorization
function init_request(token) {
  requestJson = requestFactory({
    debug: false,
    cheerio: false,
    json: true,
    jar: j,
    headers: {
      Authorization: `Bearer ` + token,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
      Accept: '*/*'
    }
  })
}

// Fonction d'authentification au site
function authenticate(username, password) {
  // Authentification et récupération du token
  return requestHtml(`${baseUrl}`)
    .then(() => {
      return requestJson({
        uri: `${loginUrl}`,
        method: 'POST',
        json: {
          email: username,
          password: password,
          group: 'ec'
        },
        transform: (body, response) => [response.statusCode, body]
      })
    })
    .catch(err => {
      if (err.statusCode == 403) {
        throw new Error(errors.LOGIN_FAILED)
      } else {
        throw err
      }
    })
    .then(([statusCode, body]) => {
      if (statusCode === 200) {
        // On réinitialise les requests avec le token
        init_request(body.token)

        return body
      } else {
        throw new Error(errors.VENDOR_DOWN)
      }
    })
}

// Import des Factures
async function getFactures(fields) {
  // Récupération de la liste des factures
  log('info', 'Récupération de la liste des factures liées au compte')
  const liste_factures = await requestJson(`${listefacturesUrl}`)

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
    fetchFile: async function(d) {
      log('info', 'Récupération facture détaillée : ' + d.vendorRef)
      return requestJson({
        uri: `${fichierdlUrl}`,
        method: 'POST',
        json: {
          billingId: d.vendorRef
        }
      }).pipe(new PassThrough())
    }
  }))

  // Import des factures dans COZY
  log('info', 'Sauvegarde des factures dans Cozy')
  await saveBills(factures, fields, {
    subPath: '',
    identifiers: ['prixtel'],
    fileIdAttributes: ['vendorRef'],
    sourceAccount: fields.login,
    sourceAccountIdentifier: fields.login,
    contentType: true,
    fileAttributes: {
      metadata: {
        importDate: new Date(),
        contentAuthor: 'prixtel',
        version: 1,
        isSubscription: true,
        carbonCopy: true,
        qualification: Qualification.getByLabel('phone_invoice')
      }
    }
  })
}

// Import des documents
async function getDocuments(fields) {
  // Récupération de la liste des lignes liées au compte
  log('info', 'Récupération de la liste des lignes liées au compte')
  let liste_lignes = await requestJson(`${listelignesUrl}`)

  // Récupération de la liste des documents pour chaque ligne et mise en forme
  const documents = []

  // Récupération des CGV , Guide tarifaire, ...
  for (const ligne of liste_lignes) {
    log(
      'info',
      'Récupértation et mise en forme des documents contractuels de la ligne : ' +
        ligne.phoneNumber
    )
    let liste_documents = await requestJson(
      `${listedocumentsUrl}/` + ligne.phoneNumber
    )

    // Conditions générales de vente
    if (liste_documents.cgv) {
      documents.push({
        fileurl: liste_documents.cgv,
        filename: formaliseNomDocument('CGV', liste_documents.phoneNumber)
      })
    }

    // Guide tarifaire
    if (liste_documents.offer.offerGt) {
      documents.push({
        fileurl: liste_documents.offer.offerGt,
        filename: formaliseNomDocument('OFFER_GT', liste_documents.phoneNumber)
      })
    }

    // Guide tarifaire internationnal
    if (liste_documents.offer.offerGtIntl) {
      documents.push({
        fileurl: liste_documents.offer.offerGtIntl,
        filename: formaliseNomDocument(
          'OFFER_GT_INTL',
          liste_documents.phoneNumber
        )
      })
    }

    // Fiche standardisee
    if (liste_documents.offer.offerLink) {
      documents.push({
        fileurl: liste_documents.offer.offerLink,
        filename: formaliseNomDocument(
          'OFFER_LINK',
          liste_documents.phoneNumber
        )
      })
    }

    // Contrat
    documents.push({
      filename: formaliseNomDocument('CONTRAT', liste_documents.phoneNumber),
      fetchFile: async function() {
        log('info', 'Récupération du contrat : ' + liste_documents.phoneNumber)
        return requestJson({
          uri: `${fichierdlUrl}`,
          method: 'POST',
          json: {
            extra: liste_documents.phoneNumber,
            fileTypeSlug: 'customers_contract'
          }
        }).pipe(new PassThrough())
      },
      metadata: {
        importDate: new Date(),
        version: 1
      }
    })
  }

  // Téléchargement des fichiers
  log('info', 'Sauvegarde des documents contractuels dans Cozy')
  await saveFiles(documents, fields, {
    identifiers: ['prixtel'],
    fileIdAttributes: ['filename'],
    sourceAccount: fields.login,
    sourceAccountIdentifier: fields.login,
    contentType: true
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
  let nom
  if (type == 'CGV') nom = 'CGV'
  else if (type == 'OFFER_GT') nom = 'Guide_Tarifaire'
  else if (type == 'OFFER_GT_INTL') nom = 'Guide_Tarifaire_International'
  else if (type == 'OFFER_LINK') nom = 'Fiche_Standardisee'
  else if (type == 'CONTRAT') nom = 'Contrat'
  else if (type == 'MANDAT') nom = 'Mandat_Sepa'

  if (num_ligne == '') return VENDOR + '_' + nom + '.pdf'
  else return VENDOR + '_' + nom + '_' + num_ligne + '.pdf'
}
