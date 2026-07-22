import Brand from '../components/Brand'

export const LEGAL_CONTACT = 'soporte@botly.com.ar'
const LAST_UPDATED = '18 de julio de 2026'

const LEGAL_ROUTES = [
  { path: '/privacy', label: 'Privacidad' },
  { path: '/terms', label: 'Terminos' },
  { path: '/data-deletion', label: 'Eliminacion de datos' },
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-zinc-400">{children}</div>
    </section>
  )
}

function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="flex flex-col gap-2 pl-5 list-disc marker:text-zinc-600">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  )
}

function Contact() {
  return (
    <p>
      Consultas sobre este documento:{' '}
      <a href={`mailto:${LEGAL_CONTACT}`} className="text-blue-400 hover:text-blue-300 underline underline-offset-2">
        {LEGAL_CONTACT}
      </a>
    </p>
  )
}

function LegalLayout({ title, summary, current, children }: {
  title: string
  summary: string
  current: string
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50">
      <header className="border-b border-zinc-800">
        <div className="mx-auto max-w-3xl px-5 sm:px-8 py-4 flex items-center justify-between gap-3">
          <a href="/" className="min-w-0"><Brand /></a>
          <span className="text-xs text-zinc-500 shrink-0">Beta privada</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 sm:px-8 py-10 sm:py-14 flex flex-col gap-10">
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-zinc-400 leading-relaxed">{summary}</p>
          <p className="text-xs text-zinc-600">Ultima actualizacion: {LAST_UPDATED}</p>
        </div>

        <div className="flex flex-col gap-9">{children}</div>

        <footer className="border-t border-zinc-800 pt-6 flex flex-col gap-4">
          <nav className="flex flex-wrap gap-x-5 gap-y-2">
            {LEGAL_ROUTES.filter(r => r.path !== current).map(r => (
              <a key={r.path} href={r.path} className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors">
                {r.label}
              </a>
            ))}
            <a href="/" className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors">Volver al panel</a>
          </nav>
          <p className="text-xs text-zinc-600">© {new Date().getFullYear()} Botly</p>
        </footer>
      </main>
    </div>
  )
}

export function PrivacyPage() {
  return (
    <LegalLayout
      current="/privacy"
      title="Politica de Privacidad"
      summary="Botly Gateway es la plataforma que conecta cuentas de WhatsApp con Botly. Este documento explica que datos tratamos, con que fin y como ejercer tus derechos. Aplica a la beta privada del servicio."
    >
      <Section title="Responsable del tratamiento">
        <p>
          El responsable del servicio es <strong className="text-zinc-200">Botly</strong>. Podes contactarnos en{' '}
          <a href={`mailto:${LEGAL_CONTACT}`} className="text-blue-400 hover:text-blue-300 underline underline-offset-2">{LEGAL_CONTACT}</a>.
        </p>
      </Section>

      <Section title="Que datos almacenamos">
        <Bullets items={[
          <><strong className="text-zinc-300">Datos de la conexion:</strong> nombre de la conexion, identificador del numero de telefono (phone number ID), identificador de la cuenta de WhatsApp Business (WABA ID) y estado de la conexion.</>,
          <><strong className="text-zinc-300">Credenciales de acceso:</strong> los tokens que Meta emite durante el alta. Los tokens no se guardan en texto plano: se almacena una referencia y un hash para poder validarlos y diagnosticar problemas.</>,
          <><strong className="text-zinc-300">Mensajes:</strong> el contenido y los metadatos de los mensajes que se intercambian entre WhatsApp y Botly, necesarios para entregar la conversacion a su destino.</>,
          <><strong className="text-zinc-300">Registros tecnicos:</strong> fechas y horas, estado de entrega, codigos de error y eventos de auditoria de la conexion.</>,
        ]} />
      </Section>

      <Section title="Para que usamos los datos">
        <Bullets items={[
          'Operar el servicio: entregar los mensajes entre WhatsApp y Botly.',
          'Mantener y restablecer las conexiones de WhatsApp asociadas a tu cuenta.',
          'Diagnosticar fallas, investigar errores de entrega y dar soporte.',
          'Proteger el servicio frente a usos abusivos o accesos no autorizados.',
        ]} />
        <p>
          No vendemos datos personales, no los cedemos a terceros con fines comerciales y no los utilizamos para
          publicidad ni para entrenar modelos.
        </p>
      </Section>

      <Section title="Terceros involucrados">
        <p>
          El servicio se apoya en la <strong className="text-zinc-200">WhatsApp Cloud API de Meta</strong>. Al conectar un
          numero oficial, Meta procesa los mensajes segun sus propias politicas. La infraestructura del servicio se aloja
          en servidores contratados a nuestro proveedor de hosting.
        </p>
      </Section>

      <Section title="Conservacion">
        <p>
          Conservamos los datos de la conexion mientras la conexion siga activa. Al eliminar una conexion desde el panel se
          borran de inmediato sus credenciales, su metadata, sus webhooks y sus claves de acceso. Los registros tecnicos se
          conservan por un periodo acotado con fines de diagnostico y seguridad.
        </p>
      </Section>

      <Section title="Seguridad">
        <p>
          El acceso a la API esta protegido por claves por instancia. Las credenciales se guardan con permisos restringidos
          y sin exponer los tokens en texto plano. Aun asi, ningun sistema es completamente infalible: si detectas un
          problema de seguridad, escribinos.
        </p>
      </Section>

      <Section title="Tus derechos">
        <p>
          Podes solicitar el acceso, la rectificacion o la eliminacion de tus datos escribiendo a{' '}
          <a href={`mailto:${LEGAL_CONTACT}`} className="text-blue-400 hover:text-blue-300 underline underline-offset-2">{LEGAL_CONTACT}</a>.
          El procedimiento de eliminacion esta detallado en{' '}
          <a href="/data-deletion" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">Eliminacion de datos</a>.
        </p>
      </Section>

      <Section title="Contacto">
        <Contact />
      </Section>
    </LegalLayout>
  )
}

export function TermsPage() {
  return (
    <LegalLayout
      current="/terms"
      title="Terminos del Servicio"
      summary="Estas condiciones regulan el uso de Botly Gateway durante su beta privada. Al usar el servicio aceptas los terminos descritos aqui."
    >
      <Section title="El servicio">
        <p>
          Botly Gateway permite conectar cuentas de WhatsApp — mediante WhatsApp Cloud API oficial o vinculacion por
          codigo QR — para que Botly pueda enviar y recibir mensajes en tu nombre. El servicio actua como intermediario
          tecnico entre WhatsApp y tu cuenta de Botly.
        </p>
      </Section>

      <Section title="Estado de beta">
        <p>
          El servicio se encuentra en <strong className="text-zinc-200">beta privada</strong>. Puede presentar
          interrupciones, cambios de funcionalidad o perdida de configuraciones sin aviso previo. No se ofrece un acuerdo
          de nivel de servicio (SLA) ni garantia de disponibilidad durante esta etapa.
        </p>
      </Section>

      <Section title="Uso aceptable y responsabilidades">
        <p>Al usar el servicio te comprometes a:</p>
        <Bullets items={[
          <>Cumplir las <strong className="text-zinc-300">politicas de WhatsApp Business</strong> y los terminos de Meta, incluidas las reglas sobre mensajes no solicitados.</>,
          'Contar con el consentimiento de las personas a las que enviás mensajes.',
          'No utilizar el servicio para spam, fraude, suplantacion de identidad ni contenido ilegal.',
          'Ser el titular de los numeros y cuentas de WhatsApp Business que conectes, o contar con autorizacion para operarlos.',
          'Resguardar las claves de acceso de tus conexiones y notificarnos si sospechas un uso indebido.',
        ]} />
        <p>
          Sos responsable del contenido de los mensajes que se envian a traves de tus conexiones y de las consecuencias
          de su uso. El incumplimiento de estas condiciones puede derivar en la suspension de la cuenta.
        </p>
      </Section>

      <Section title="Disponibilidad y cambios">
        <p>
          Podemos modificar, suspender o discontinuar el servicio, en todo o en parte, en cualquier momento durante la
          beta. Tambien podemos actualizar estos terminos; si el cambio es relevante, lo comunicaremos por los medios de
          contacto disponibles.
        </p>
      </Section>

      <Section title="Limitacion de responsabilidad">
        <p>
          El servicio se ofrece <strong className="text-zinc-200">"tal cual"</strong>, sin garantias expresas ni implicitas
          de comerciabilidad, adecuacion a un fin particular o funcionamiento ininterrumpido.
        </p>
        <p>
          En la maxima medida permitida por la ley aplicable, Botly no sera responsable por daños indirectos,
          incidentales o consecuentes, ni por lucro cesante, perdida de datos o de oportunidades comerciales derivados
          del uso o de la imposibilidad de usar el servicio. Tampoco respondemos por interrupciones, cambios de politica o
          suspensiones originadas en Meta o WhatsApp, al ser servicios de terceros fuera de nuestro control.
        </p>
      </Section>

      <Section title="Baja del servicio">
        <p>
          Podes dejar de usar el servicio en cualquier momento eliminando tus conexiones desde el panel. Consulta{' '}
          <a href="/data-deletion" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">Eliminacion de datos</a>{' '}
          para el borrado completo de tu informacion.
        </p>
      </Section>

      <Section title="Contacto">
        <Contact />
      </Section>
    </LegalLayout>
  )
}

export function DataDeletionPage() {
  return (
    <LegalLayout
      current="/data-deletion"
      title="Eliminacion de datos"
      summary="Podes eliminar en cualquier momento los datos asociados a tus conexiones de WhatsApp. Aca te explicamos las dos formas de hacerlo y los plazos que manejamos."
    >
      <Section title="Opcion 1: eliminar desde el panel (inmediato)">
        <p>
          Es la via mas rapida y no requiere esperar una respuesta nuestra. En el panel de Botly Gateway, abri la
          conexion que quieras dar de baja y usa la opcion <strong className="text-zinc-200">Eliminar</strong>.
        </p>
        <p>Al eliminar una conexion se borran de forma inmediata:</p>
        <Bullets items={[
          'Las credenciales oficiales asociadas (tokens de Meta y sus referencias).',
          'La metadata de la conexion (identificadores de numero y de cuenta de WhatsApp Business).',
          'Los webhooks configurados para esa conexion.',
          'Las claves de acceso de la instancia.',
          'La instancia de WhatsApp en el motor de conexiones.',
        ]} />
      </Section>

      <Section title="Opcion 2: solicitarlo por correo">
        <p>
          Si no tenes acceso al panel o queres eliminar toda tu informacion, escribinos a{' '}
          <a href={`mailto:${LEGAL_CONTACT}`} className="text-blue-400 hover:text-blue-300 underline underline-offset-2">{LEGAL_CONTACT}</a>{' '}
          con el asunto <strong className="text-zinc-200">"Eliminacion de datos"</strong>.
        </p>
        <p>Para poder identificar tu cuenta, incluí en el mensaje:</p>
        <Bullets items={[
          'El numero de telefono de WhatsApp o el identificador de la cuenta (WABA ID).',
          'El nombre de la conexion, si lo conoces.',
          'Si queres eliminar una conexion puntual o toda tu informacion.',
        ]} />
      </Section>

      <Section title="Plazos">
        <Bullets items={[
          <><strong className="text-zinc-300">Confirmacion de recepcion:</strong> dentro de las 72 horas habiles siguientes a tu solicitud.</>,
          <><strong className="text-zinc-300">Eliminacion efectiva:</strong> hasta 30 dias corridos desde la confirmacion.</>,
          <><strong className="text-zinc-300">Copias de resguardo y registros tecnicos:</strong> pueden persistir hasta 90 dias antes de su purga definitiva.</>,
        ]} />
      </Section>

      <Section title="Que no podemos eliminar">
        <p>
          Los datos que Meta conserva por su cuenta como parte de la WhatsApp Cloud API se rigen por las politicas de
          Meta. Para eliminarlos debes gestionarlo directamente desde tu cuenta de Meta Business. Tampoco podemos
          eliminar los mensajes ya entregados en los dispositivos de los destinatarios.
        </p>
      </Section>

      <Section title="Contacto">
        <Contact />
      </Section>
    </LegalLayout>
  )
}
