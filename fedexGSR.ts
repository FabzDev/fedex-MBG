import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { createWorker } from "tesseract.js";
import XLSX from "xlsx";
import * as fs from "fs";
import gsrList from "./data/in/gsrList.json";
import { rejectReasons } from "./reasons";
import { GsrInterface } from "./Interfaces/gsr.interface";

puppeteer.use(StealthPlugin());

const url = "https://www.fedex.com/servlet/InvoiceServlet?link=4&jsp_name=adjustment&orig_country=US&language=english/";
const gsrResultArray: string[] = [];
const clip = { x: 290, y: 190, width: 700, height: 120 };


async function mainPage(page: Page) {
    await page.goto(url);
    await page.click('input[value="E"]');
    await page.click('input[value="invoice"]');
    await page.click('input[name="NewReq"]');
    await applyDelay(2000);
}


async function formPage( page: Page, trackingNumber: string, invoiceNumber: string) {
    await page.click('input[name="tracking_nbr"]', { clickCount: 3 });
    await page.type('input[name="tracking_nbr"]', trackingNumber);
    await page.click('input[name="invoice_nbr"]', { clickCount: 3 });
    await page.type('input[name="invoice_nbr"]', invoiceNumber);
    await page.click('input[value="Send Request"]');
    await refinedWaitForNavigation(page);
}


async function convertReponseImgToTxt( page: Page, trackingNumber: string, invoiceNumber: string) {
  const buffImg = await page.screenshot({
      encoding: "binary",
      clip: clip,
      path: `./GSRimgs/${trackingNumber}_${invoiceNumber}.png`,
  });
  const worker = await createWorker("eng");
  const scanedData = await worker.recognize(buffImg);
  await worker.terminate();
  return scanedData.data.text.toUpperCase();
}


async function getDenyReason(response: string){
    for (const keywords in rejectReasons) {
        if (response.includes(keywords)) {
            return rejectReasons[keywords as keyof typeof rejectReasons];
        }
    }
}


function createExcelFile(dataArray: string[]) {
    // Crear un nuevo libro de Excel
    const workbook = XLSX.utils.book_new();

    // Crear una nueva hoja
    const worksheet = XLSX.utils.aoa_to_sheet([
        ["TRACKING NUMBER", "INVOICE NUMBER", "DESCRIPTION"],
    ]);

    // Iterar sobre cada elemento del arreglo
    dataArray.forEach( dataString => {
        // Separar el string por el caracter "|"
        const splitedStr = dataString.split(" | ");

        // Agregar una fila con los datos a la hoja
        const lastRow = XLSX.utils.sheet_add_aoa(worksheet, [splitedStr], { origin: -1 });
    });

    // Agregar la hoja al libro
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");

    try {
        // Guardar el libro como archivo Excel
        XLSX.writeFile(workbook, "./data/out/test.xlsx");
    } catch (error) {
        console.log(error);
        XLSX.writeFile(workbook, "./data/out/test2.xlsx");
    }
}


async function refinedWaitForNavigation(page: Page) {
    await Promise.race([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }),
        new Promise((resolve, reject) => {
            setTimeout(
                () => reject(new Error("Timeout waiting for navigation")),
                20000
            );
        }),
    ]);
}


async function scrapPage(page: Page, trackingNumber: string, invoiceNumber: string, outDataArray: string[]){
    let counter = 0;
    await mainPage(page);

    await formPage(page, trackingNumber, invoiceNumber);

    let responseTxt: string = await convertReponseImgToTxt( page, trackingNumber, invoiceNumber );

    console.log( `\nIteration 1\nIncludes Track#: ${responseTxt.includes( trackingNumber )}\n${responseTxt}`);

    if (!responseTxt.includes(trackingNumber)) {
        while (counter < 2) {
            await page.goBack();
            await applyDelay(2000);
            await page.click('input[value="Send Request"]');
            await refinedWaitForNavigation(page);
            responseTxt = await convertReponseImgToTxt( page, trackingNumber, invoiceNumber);
            console.log( `\nIteration ${ counter + 2 }\nIncludes Track#: ${responseTxt.includes( trackingNumber )}\n${responseTxt}`);
            if (responseTxt.includes(trackingNumber)) break;
            counter++;
        }
    }

    outDataArray.push(`${trackingNumber} | ${invoiceNumber} | ${await getDenyReason(responseTxt)}`);
}


function saveData(outDataArray: string[]) {
    const jsonData = JSON.stringify(outDataArray, null, 2);
    fs.writeFileSync("./data/out/datos.json", jsonData);
    createExcelFile(outDataArray);
}


async function applyDelay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}


//START GSR
async function gsr(gsr: GsrInterface, outDataArray: string[]) {
    const trackingNumber: string = gsr["TRACKING NUMBER"];
    const invoiceNumber: string = gsr["INVOICE NUMBER"];
    const browser: Browser = await puppeteer.launch({ headless: true });
    const page: Page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    console.log(`\n\nTrack Number: ${gsr["TRACKING NUMBER"]} | Invoice Number: ${gsr["INVOICE NUMBER"]}`);
    
    try {
        await Promise.race([
            scrapPage(page, trackingNumber, invoiceNumber,gsrResultArray),
            new Promise((resolve, reject) => {
                setTimeout(
                    () => reject(new Error("Timeout waiting for navigation")),
                    60000
                );
            }),
        ]);
        
    } catch {
        console.log(`Error catched on ${gsr["TRACKING NUMBER"]}_${gsr["INVOICE NUMBER"]}`);
        outDataArray.push(`${trackingNumber} | ${invoiceNumber} | Page didn't load.`);
        return;
    } finally {
        await browser.close();
    }

}


async function main(invoices: GsrInterface[], responses: string[]) {
    for (const gsrInfo of invoices) {
        await gsr(gsrInfo, responses);
    }
    saveData(responses);
}


main(gsrList, gsrResultArray);