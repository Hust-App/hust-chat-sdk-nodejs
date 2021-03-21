function ZeroToTheLeft(numero: number, casas = 2): string {
  const casasDecimais = Math.abs(numero.toString().length - casas);

  let numeroFinal = numero.toString();
  if (numero < 10 ** casasDecimais) numeroFinal = new Array(casasDecimais).fill('0').join('') + numero;

  return numeroFinal;
}

const Timeout = (time: number): Promise<void> => new Promise(resolve => setTimeout(resolve, time));

export { ZeroToTheLeft, Timeout };
